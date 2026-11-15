// Pocket Pixels table server: a Cloudflare Worker that hands each table code
// to its own Durable Object. The Durable Object keeps the table's state,
// talks to the phones over WebSockets, and uses an alarm for bot moves,
// turn timers and dealing. The game rules themselves are the same engine the
// phones run for solo play (src/engine), wrapped by src/online/room.ts.

import { DurableObject } from "cloudflare:workers";
import { CODE_LENGTH, isValidCode, parseClientMsg, type ServerMsg } from "../../src/online/protocol";
import { Room, type RoomState, newRoom } from "../../src/online/room";

export interface Env {
  TABLES: DurableObjectNamespace<Table>;
}

interface Attachment {
  token: string | null;
}

/** Pages allowed to open a table: the published game and local testing. */
function allowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin === "https://ethanmanco.github.io") return true;
  return /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Pocket Pixels table server is running.\n", { headers: { "content-type": "text/plain" } });
    }
    const m = new RegExp(`^/table/([A-Z0-9]{${CODE_LENGTH}})$`).exec(url.pathname);
    if (!m || !isValidCode(m[1]!)) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    if (!allowedOrigin(request.headers.get("Origin"))) return new Response("Forbidden", { status: 403 });
    const stub = env.TABLES.get(env.TABLES.idFromName(m[1]!));
    const headers = new Headers(request.headers);
    headers.set("X-Table-Code", m[1]!);
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

export class Table extends DurableObject<Env> {
  private room: Room | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomState>("room");
      if (saved) this.room = this.wrap(saved);
    });
  }

  private wrap(s: RoomState): Room {
    return new Room(s, () => Date.now(), () => crypto.randomUUID());
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.room) {
      const code = request.headers.get("X-Table-Code") ?? "AAAAA";
      this.room = this.wrap(newRoom(code, crypto.getRandomValues(new Uint32Array(1))[0]!));
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // Hibernation-friendly: the object can sleep while sockets stay open.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ token: null } satisfies Attachment);
    // Show the table to the newcomer before they sit down.
    this.send(server, this.room.update(-1, []));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const room = this.room;
    if (!room || typeof raw !== "string" || raw.length > 2000) return;
    const msg = parseClientMsg(raw);
    if (!msg) return this.send(ws, { t: "error", message: "That message was not understood." });
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { token: null };

    if (msg.t === "join") {
      const r = room.join(msg.token, msg.name);
      if ("error" in r) return this.send(ws, { t: "error", message: r.error });
      ws.serializeAttachment({ token: r.token } satisfies Attachment);
      // The same player opened the table somewhere else: close the old connection.
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && (other.deserializeAttachment() as Attachment | null)?.token === r.token) {
          other.serializeAttachment({ token: null } satisfies Attachment);
          this.send(other, { t: "left" });
          other.close(4000, "Opened elsewhere");
        }
      }
      this.send(ws, { t: "welcome", seat: r.seat, token: r.token });
      return this.commit();
    }

    const token = att.token;
    if (!token) return this.send(ws, { t: "error", message: "Take a seat first." });
    let error: string | null = null;
    switch (msg.t) {
      case "act": error = room.act(token, msg.action); break;
      case "start": error = room.start(token); break;
      case "addBot": error = room.addBot(token); break;
      case "removeBot": error = room.removeBot(token, msg.seat); break;
      case "rebuy": error = room.rebuy(token); break;
      case "back": room.back(token); break;
      case "leave":
        room.leave(token);
        ws.serializeAttachment({ token: null } satisfies Attachment);
        this.send(ws, { t: "left" });
        ws.close(1000, "Left the table");
        break;
    }
    if (error) this.send(ws, { t: "error", message: error });
    await this.commit();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const token = (ws.deserializeAttachment() as Attachment | null)?.token;
    if (!this.room || !token) return;
    const stillHere = this.ctx.getWebSockets().some(
      (o) => o !== ws && (o.deserializeAttachment() as Attachment | null)?.token === token,
    );
    if (!stillHere) {
      this.room.disconnect(token);
      await this.commit();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    if (!this.room) return;
    if (this.room.tick()) await this.commit();
    else await this.arm();
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket is closing; its close handler takes care of the seat.
    }
  }

  /** Save, tell every phone what changed, and set the alarm for what comes next. */
  private async commit(): Promise<void> {
    const room = this.room!;
    const events = room.takeEvents();
    for (const ws of this.ctx.getWebSockets()) {
      const token = (ws.deserializeAttachment() as Attachment | null)?.token ?? null;
      this.send(ws, room.update(room.seatOf(token), events));
    }
    if (room.empty && this.ctx.getWebSockets().length === 0) {
      // Nobody left: forget the table.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    await this.ctx.storage.put("room", room.s);
    await this.arm();
  }

  private async arm(): Promise<void> {
    const p = this.room?.s.pending;
    if (p) await this.ctx.storage.setAlarm(p.at);
    else await this.ctx.storage.deleteAlarm();
  }
}
