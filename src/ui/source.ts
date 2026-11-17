// Where the table's updates come from. The screen only draws what a source
// sends it and passes your moves back:
//   - LocalSource: solo play. Runs the engine and the bots on this phone.
//   - OnlineSource: a table on the server, shared with friends.

import type { BotPersonality } from "../engine/bot";
import { type Level, type Notes, decideAtLevel, updateNotes } from "../engine/brain";
import {
  type Action, type GameEvent, type GameState, applyAction, createGame, rebuy, startHand, viewFor,
} from "../engine/game";
import { Rng, randomSeed } from "../engine/rng";
import { type TableView, rotateView, tableViewFor } from "../engine/view";
import { serverUrl } from "../online/config";
import { type ClientMsg, type RoomView, type ServerMsg } from "../online/protocol";
import { BotDriver } from "./drivers";
import { type Saved, START_STACK } from "./storage";
import { devSeed } from "./timing";

export interface Update {
  view: TableView;
  events: GameEvent[];
  /** Avatar key for each seat, in screen order (you first). */
  avatars: string[];
  /** Online only: who sits where, the host, and the turn timer. */
  room: RoomView | null;
}

export type Listener = (u: Update) => Promise<void>;

export interface TableSource {
  readonly online: boolean;
  /** A hand is being played (solo); the screen offers "Next hand" only when false. */
  readonly busy: boolean;
  start(listener: Listener): void;
  act(action: Action): void;
  rebuy(): void;
  dispose(): void;
}

export interface Opponent {
  name: string;
  personality: BotPersonality;
  avatar: string;
}

/** Which opponents sit at smaller solo tables (seating order is kept). */
const TABLE_PICKS: Record<number, string[]> = {
  2: ["Blaze"],
  3: ["Pebble", "Blaze"],
  4: ["Pebble", "Juniper", "Blaze"],
  5: ["Pebble", "Juniper", "Blaze", "Rook"],
};

// ---------------------------------------------------------------------------

export class LocalSource implements TableSource {
  readonly online = false;
  busy = false;
  private state!: GameState;
  private rng = new Rng(devSeed() ?? randomSeed());
  private bots: (BotDriver | null)[] = [];
  private avatars: string[] = [];
  private waiting: ((a: Action) => void) | null = null;
  private listener: Listener = async () => {};
  private pendingSize: number | null = null;
  /** What the bots have learned about each seat from public betting. */
  private notes: Notes = {};

  constructor(
    private roster: Opponent[],
    private saved: Saved,
    private persist: () => void,
  ) {
    this.setup(saved.players, saved.chips);
  }

  get seats(): number {
    return this.pendingSize ?? this.state.seats.length;
  }

  private setup(players: number, myChips: number): void {
    const names = TABLE_PICKS[players] ?? TABLE_PICKS[5]!;
    const opponents = this.roster.filter((o) => names.includes(o.name));
    this.state = createGame({
      players: [{ name: this.saved.name || "You", personality: "human" }, ...opponents],
      stack: START_STACK,
      seed: devSeed() ?? randomSeed(),
    });
    this.state.seats[0]!.stack = myChips;
    this.avatars = [this.saved.avatar, ...opponents.map((o) => o.avatar)];
    this.notes = {};
    this.bots = [
      null,
      ...opponents.map(
        (o) => new BotDriver((v) => decideAtLevel(v, o.personality, this.saved.level, this.rng, this.notes), () => 450 + this.rng.int(450)),
      ),
    ];
  }

  private emit(events: GameEvent[]): Promise<void> {
    return this.listener({ view: tableViewFor(this.state, 0), events, avatars: this.avatars, room: null });
  }

  private saveChips(): void {
    this.saved.chips = this.state.seats[0]!.stack;
    this.persist();
  }

  start(listener: Listener): void {
    this.listener = listener;
    void this.emit([]).then(() => {
      if (this.state.seats[0]!.stack > 0) void this.next();
    });
  }

  /** Deal and play one hand. */
  async next(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (this.pendingSize !== null) {
      this.setup(this.pendingSize, this.state.seats[0]!.stack);
      this.pendingSize = null;
    }
    for (const p of this.state.seats) {
      if (p.id !== 0 && p.stack === 0) this.state = rebuy(this.state, p.id, START_STACK);
    }
    const r = startHand(this.state);
    this.state = r.state;
    this.saveChips();
    await this.emit(r.events);

    while (this.state.hand!.street !== "complete") {
      const seat = this.state.hand!.toAct!;
      const bot = this.bots[seat];
      const action = bot
        ? await bot.decide(viewFor(this.state, seat))
        : await new Promise<Action>((resolve) => (this.waiting = resolve));
      let step;
      try {
        step = applyAction(this.state, seat, action);
      } catch {
        continue; // an illegal move from the screen: ask again
      }
      this.state = step.state;
      this.saveChips();
      if (step.events.some((e) => e.type === "handEnd")) {
        const dealt = this.state.seats.filter((p) => p.hole.length).map((p) => p.id);
        updateNotes(this.notes, this.state.hand!.history, dealt);
      }
      await this.emit(step.events);
    }
    this.busy = false;
    await this.emit([]);
  }

  act(action: Action): void {
    const w = this.waiting;
    this.waiting = null;
    w?.(action);
  }

  rebuy(): void {
    if (this.busy || this.state.seats[0]!.stack > 0) return;
    this.state = rebuy(this.state, 0, START_STACK);
    this.saveChips();
    void this.emit([]);
  }

  /** Your name or avatar changed in the menu. */
  updateProfile(): void {
    this.state.seats[0]!.name = this.saved.name || "You";
    this.avatars[0] = this.saved.avatar;
    void this.emit([]);
  }

  /** Change the number of players; waits for the current hand to finish. */
  setSize(players: number): void {
    if (this.busy) this.pendingSize = players;
    else {
      this.pendingSize = null;
      this.setup(players, this.state.seats[0]!.stack);
      void this.emit([]);
    }
  }

  dispose(): void {
    this.waiting = null;
  }
}

// ---------------------------------------------------------------------------

export interface OnlineCallbacks {
  /** Short status for the message line ("Connecting...", errors). */
  status: (text: string) => void;
  /** You left, opened the table somewhere else, or the host removed you ("kicked"). */
  left: (reason?: "kicked") => void;
}

const TOKEN_KEY = "pocket-pixels:tokens";

function loadTokens(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function saveToken(code: string, token: string): void {
  try {
    const all = loadTokens();
    all[code] = token;
    localStorage.setItem(TOKEN_KEY, JSON.stringify(all));
  } catch {
    // Without storage you just get a new seat after a reconnect.
  }
}

export class OnlineSource implements TableSource {
  readonly online = true;
  readonly busy = false;
  private ws: WebSocket | null = null;
  private listener: Listener = async () => {};
  private mySeat = -1;
  private seatCount = 0;
  private closedOnPurpose = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly code: string,
    private name: string,
    private avatar: string,
    private cb: OnlineCallbacks,
  ) {}

  start(listener: Listener): void {
    this.listener = listener;
    document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }

  private onVisible = () => {
    if (document.visibilityState === "visible" && !this.ws && !this.closedOnPurpose) this.connect();
  };

  private connect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.cb.status(this.retry ? "Reconnecting..." : "Connecting to the table...");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${serverUrl()}/table/${this.code}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ t: "join", name: this.name, token: loadTokens()[this.code], avatar: this.avatar });
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.closedOnPurpose) this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closedOnPurpose) return;
    const wait = Math.min(10_000, 1000 * 2 ** this.retry++);
    this.cb.status("Lost the connection. Reconnecting...");
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case "welcome":
        this.mySeat = msg.seat;
        saveToken(this.code, msg.token);
        break;
      case "update": {
        this.seatCount = msg.view.seats.length;
        const { view, events } = rotateView(msg.view, msg.events);
        const me = Math.max(0, msg.view.me);
        const rot = <T,>(arr: T[]) => arr.map((_, i) => arr[(i + me) % arr.length]!);
        const room = { ...msg.room, seats: rot(msg.room.seats) };
        void this.listener({ view, events, avatars: room.seats.map((s) => s.avatar || "open"), room });
        break;
      }
      case "error":
        this.cb.status(msg.message);
        break;
      case "left":
        this.closedOnPurpose = true;
        this.cb.left(msg.reason);
        break;
    }
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** A seat number on the screen (you are 0) back to the server's numbering. */
  private realSeat(screenSeat: number): number {
    return this.seatCount ? (screenSeat + Math.max(0, this.mySeat)) % this.seatCount : screenSeat;
  }

  act(action: Action): void { this.send({ t: "act", action }); }
  rebuy(): void { this.send({ t: "rebuy" }); }
  startGame(): void { this.send({ t: "start" }); }
  addBot(): void { this.send({ t: "addBot" }); }
  /** Host only: remove a bot or a person. */
  kick(screenSeat: number): void { this.send({ t: "kick", seat: this.realSeat(screenSeat) }); }
  sitOut(): void { this.send({ t: "sitOut" }); }
  back(): void { this.send({ t: "back" }); }
  pause(paused: boolean): void { this.send({ t: "pause", paused }); }
  setLevel(level: Level): void { this.send({ t: "level", level }); }

  profile(name: string, avatar: string): void {
    this.name = name;
    this.avatar = avatar;
    this.send({ t: "profile", name, avatar });
  }

  leave(): void {
    this.closedOnPurpose = true;
    this.send({ t: "leave" });
    setTimeout(() => this.ws?.close(), 300);
  }

  dispose(): void {
    this.closedOnPurpose = true;
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
