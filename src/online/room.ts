// One online table: seats, the host, bots, turn timers and dealing. Pure
// logic with no networking, so it can be tested on its own; the Cloudflare
// Durable Object in server/ wraps it with WebSockets, storage and alarms.

import { type BotPersonality, STYLES, decide } from "../engine/bot";
import {
  type Action, type GameEvent, type GameState, applyAction, createGame, legalActions, startHand, viewFor,
} from "../engine/game";
import { Rng } from "../engine/rng";
import { tableViewFor } from "../engine/view";
import { MAX_SEATS, type RoomView, START_CHIPS, type ServerMsg } from "./protocol";

/** How long a person has to act, and how long for someone who is away. */
export const TURN_MS = 30_000;
export const AWAY_TURN_MS = 3_000;
/** A table with nobody connected is forgotten after this long. */
export const EXPIRE_MS = 30 * 60_000;

const BOT_ROSTER: { name: string; personality: BotPersonality; avatar: string }[] = [
  { name: "Pebble", personality: "cautious", avatar: "pebble" },
  { name: "Juniper", personality: "loose", avatar: "juniper" },
  { name: "Blaze", personality: "aggressive", avatar: "blaze" },
  { name: "Rook", personality: "steady", avatar: "rook" },
];

export interface RoomSeat {
  kind: "human" | "bot";
  name: string;
  avatar: string;
  /** Secret that lets a person get their seat back after a reconnect. */
  token: string | null;
  personality: BotPersonality | null;
  connected: boolean;
  /** Missed turns in a row; sits out once it reaches 2. */
  timeouts: number;
  away: boolean;
  /** Leaves (or is removed) when the current hand ends. */
  leaving: boolean;
}

export interface Pending {
  kind: "bot" | "timeout" | "nextHand" | "expire";
  at: number;
  hand: number;
  seat: number;
}

export interface RoomState {
  code: string;
  seats: (RoomSeat | null)[];
  hostToken: string | null;
  started: boolean;
  game: GameState;
  pending: Pending | null;
  rngState: number;
}

export function newRoom(code: string, seed: number): RoomState {
  return {
    code,
    seats: new Array(MAX_SEATS).fill(null),
    hostToken: null,
    started: false,
    game: createGame({
      players: Array.from({ length: MAX_SEATS }, () => ({ name: "", personality: "human" as const })),
      stack: 0,
      seed,
    }),
    pending: null,
    rngState: seed ^ 0x5eed,
  };
}

/** Rough time a phone needs to animate these events, so bots and timers wait for it. */
export function animationMs(events: readonly GameEvent[]): number {
  let ms = 0;
  for (const e of events) {
    if (e.type === "deal") ms += 1400;
    else if (e.type === "street") ms += 1100;
    else if (e.type === "handEnd") ms += e.result.showdown ? 3200 : 1600;
    else if (e.type === "action") ms += 250;
  }
  return ms;
}

export class Room {
  /** Events since the last broadcast. */
  events: GameEvent[] = [];
  /** Nobody came back in time: the server should delete this table. */
  expired = false;

  constructor(
    public s: RoomState,
    private now: () => number,
    private makeToken: () => string,
  ) {}

  // ------------------------------------------------------------------ helpers

  seatOf(token: string | null | undefined): number {
    if (!token) return -1;
    return this.s.seats.findIndex((p) => p?.token === token);
  }

  private get hand() {
    const h = this.s.game.hand;
    return h && h.street !== "complete" ? h : null;
  }

  /** Is this seat holding cards in the hand being played? */
  private inHand(seat: number): boolean {
    const p = this.s.game.seats[seat];
    return !!this.hand && !!p && (p.status === "active" || p.status === "allin");
  }

  private withRng<T>(fn: (rng: Rng) => T): T {
    const rng = new Rng(this.s.rngState);
    const out = fn(rng);
    this.s.rngState = rng.state;
    return out;
  }

  private apply(seat: number, action: Action): void {
    const r = applyAction(this.s.game, seat, action);
    this.s.game = r.state;
    this.events.push(...r.events);
  }

  private setEngineSeat(seat: number, name: string, personality: RoomSeat["personality"], stack: number): void {
    const p = this.s.game.seats[seat]!;
    p.name = name;
    p.personality = personality ?? "human";
    p.stack = stack;
  }

  private free(seat: number): void {
    const p = this.s.seats[seat];
    this.s.seats[seat] = null;
    this.setEngineSeat(seat, "", null, 0);
    if (p?.token && p.token === this.s.hostToken) {
      this.s.hostToken = this.s.seats.find((x) => x?.kind === "human" && !x.leaving)?.token ?? null;
    }
  }

  private isHost(token: string): boolean {
    return !!token && token === this.s.hostToken;
  }

  // ------------------------------------------------------------------ people

  /** Take a seat, or get your old seat back with your token. */
  join(token: string | undefined, name: string): { seat: number; token: string } | { error: string } {
    const existing = this.seatOf(token);
    if (existing >= 0) {
      const p = this.s.seats[existing]!;
      p.connected = true;
      p.away = false;
      p.timeouts = 0;
      p.leaving = false;
      this.schedule();
      return { seat: existing, token: p.token! };
    }
    const seat = this.s.seats.findIndex((p) => p === null);
    if (seat < 0) return { error: "This table is full." };
    const t = this.makeToken();
    this.s.seats[seat] = {
      kind: "human", name, avatar: `p${seat}`, token: t, personality: null,
      connected: true, timeouts: 0, away: false, leaving: false,
    };
    // A newcomer mid-hand sits out until the next deal (their engine seat is "out").
    this.setEngineSeat(seat, name, null, START_CHIPS);
    if (!this.s.hostToken) this.s.hostToken = t;
    this.schedule();
    return { seat, token: t };
  }

  disconnect(token: string): void {
    const seat = this.seatOf(token);
    if (seat < 0) return;
    this.s.seats[seat]!.connected = false;
    // If it was their turn, stop waiting the full time. If nothing else is
    // scheduled, this starts the countdown to forget an abandoned table.
    // (Rescheduling otherwise would reset someone else's turn timer.)
    if (this.hand?.toAct === seat || !this.s.pending) this.schedule();
  }

  leave(token: string): void {
    const seat = this.seatOf(token);
    if (seat < 0) return;
    const p = this.s.seats[seat]!;
    p.connected = false;
    if (this.inHand(seat)) {
      p.leaving = true;
      if (this.hand?.toAct === seat) this.autoAct(seat);
    } else {
      this.free(seat);
    }
    this.schedule();
  }

  back(token: string): void {
    const seat = this.seatOf(token);
    if (seat < 0) return;
    const p = this.s.seats[seat]!;
    p.away = false;
    p.timeouts = 0;
    this.schedule();
  }

  rebuy(token: string): string | null {
    const seat = this.seatOf(token);
    if (seat < 0) return "You are not seated.";
    const p = this.s.game.seats[seat]!;
    if (p.stack > 0 || this.inHand(seat)) return "You can rebuy when you are out of chips.";
    p.stack = START_CHIPS;
    this.schedule();
    return null;
  }

  // ------------------------------------------------------------------ host

  addBot(token: string): string | null {
    if (!this.isHost(token)) return "Only the host can add bots.";
    const seat = this.s.seats.findIndex((p) => p === null);
    if (seat < 0) return "The table is full.";
    const used = new Set(this.s.seats.map((p) => p?.name));
    const bot = BOT_ROSTER.find((b) => !used.has(b.name));
    if (!bot) return "All the bots are already seated.";
    this.s.seats[seat] = {
      kind: "bot", name: bot.name, avatar: bot.avatar, token: null, personality: bot.personality,
      connected: true, timeouts: 0, away: false, leaving: false,
    };
    this.setEngineSeat(seat, bot.name, bot.personality, START_CHIPS);
    this.schedule();
    return null;
  }

  removeBot(token: string, seat: number): string | null {
    if (!this.isHost(token)) return "Only the host can remove bots.";
    const p = this.s.seats[seat];
    if (!p || p.kind !== "bot") return "That seat is not a bot.";
    if (this.inHand(seat)) p.leaving = true;
    else this.free(seat);
    this.schedule();
    return null;
  }

  start(token: string): string | null {
    if (!this.isHost(token)) return "Only the host can start the game.";
    if (this.s.started) return null;
    if (this.s.seats.filter(Boolean).length < 2) return "Add a bot or invite a friend first.";
    this.s.started = true;
    this.schedule();
    return null;
  }

  // ------------------------------------------------------------------ play

  act(token: string, action: Action): string | null {
    const seat = this.seatOf(token);
    if (seat < 0) return "You are not seated.";
    if (this.hand?.toAct !== seat) return "It is not your turn.";
    try {
      this.apply(seat, action);
    } catch (e) {
      return e instanceof Error ? e.message : "That move is not allowed.";
    }
    const p = this.s.seats[seat]!;
    p.timeouts = 0;
    p.away = false;
    this.schedule();
    return null;
  }

  /** Check if possible, otherwise fold. Used for timeouts and players who left. */
  private autoAct(seat: number): void {
    const legal = legalActions(this.s.game, seat);
    this.apply(seat, legal.canCheck ? { type: "check" } : { type: "fold" });
  }

  /** Can a new hand be dealt? Two players with chips, and someone watching. */
  private dealable(): number[] {
    const players: number[] = [];
    let watching = false;
    this.s.seats.forEach((p, seat) => {
      if (!p || p.leaving) return;
      const sittingOut = p.kind === "human" && (p.away || !p.connected);
      if (p.kind === "human" && !sittingOut) watching = true;
      if (!sittingOut && (this.s.game.seats[seat]!.stack > 0 || p.kind === "bot")) players.push(seat);
    });
    return watching && players.length >= 2 ? players : [];
  }

  private deal(): void {
    // Settle who left during the last hand, and top up broke bots.
    this.s.seats.forEach((p, seat) => {
      if (p?.leaving) this.free(seat);
      else if (p?.kind === "bot" && this.s.game.seats[seat]!.stack === 0) this.s.game.seats[seat]!.stack = START_CHIPS;
    });
    const players = this.dealable();
    if (!players.length) return;
    // Players sitting out keep their chips but are not dealt in.
    const parked = new Map<number, number>();
    this.s.game.seats.forEach((p) => {
      if (!players.includes(p.id) && p.stack > 0) {
        parked.set(p.id, p.stack);
        p.stack = 0;
      }
    });
    const r = startHand(this.s.game);
    this.s.game = r.state;
    for (const [seat, stack] of parked) this.s.game.seats[seat]!.stack = stack;
    this.events.push(...r.events);
  }

  /** Work out what happens next and when (a bot's move, a turn timer, the next deal). */
  schedule(): void {
    const now = this.now();
    const lag = animationMs(this.events);
    const h = this.hand;
    if (!this.s.started) {
      this.s.pending = null;
    } else if (h) {
      const seat = h.toAct!;
      const p = this.s.seats[seat];
      if (!p || p.kind === "bot" || p.leaving) {
        const think = p?.kind === "bot" ? this.withRng((rng) => 700 + rng.int(800)) : 400;
        this.s.pending = { kind: "bot", at: now + lag + think, hand: h.number, seat };
      } else {
        const ms = p.connected && !p.away ? TURN_MS : AWAY_TURN_MS;
        this.s.pending = { kind: "timeout", at: now + lag + ms, hand: h.number, seat };
      }
    } else if (this.dealable().length) {
      const after = this.s.game.hand ? 2500 : 300;
      this.s.pending = { kind: "nextHand", at: now + lag + after, hand: this.s.game.handNo, seat: -1 };
    } else {
      this.s.pending = null;
    }
    // Nobody connected and nothing left to play: forget the table after a while.
    if (!this.s.pending && !this.s.seats.some((p) => p?.kind === "human" && p.connected)) {
      this.s.pending = { kind: "expire", at: now + EXPIRE_MS, hand: this.s.game.handNo, seat: -1 };
    }
  }

  /** Run whatever is due. Returns true if anything changed. */
  tick(): boolean {
    const p = this.s.pending;
    if (!p || this.now() < p.at) return false;
    this.s.pending = null;
    const h = this.hand;
    if (p.kind === "expire") {
      this.expired = true;
      return true;
    }
    if (p.kind === "nextHand") {
      if (!h) this.deal();
    } else if (h && h.number === p.hand && h.toAct === p.seat) {
      const seat = this.s.seats[p.seat];
      if (p.kind === "bot") {
        if (seat?.kind === "bot") {
          const style = STYLES[seat.personality!];
          const action = this.withRng((rng) => decide(viewFor(this.s.game, p.seat), style, rng, 250));
          this.apply(p.seat, action);
        } else {
          this.autoAct(p.seat);
        }
      } else {
        this.autoAct(p.seat);
        if (seat) {
          seat.timeouts++;
          if (seat.timeouts >= 2) seat.away = true;
        }
      }
    }
    this.schedule();
    return true;
  }

  // ------------------------------------------------------------------ what phones see

  roomView(): RoomView {
    const p = this.s.pending;
    return {
      code: this.s.code,
      started: this.s.started,
      turnMs: TURN_MS,
      turnMsLeft: p?.kind === "timeout" ? Math.max(0, p.at - this.now()) : null,
      seats: this.s.seats.map((x) =>
        x
          ? { kind: x.kind, name: x.name, avatar: x.avatar, connected: x.connected, away: x.away, host: !!x.token && x.token === this.s.hostToken }
          : { kind: "open", name: "", avatar: "", connected: false, away: false, host: false },
      ),
    };
  }

  /** The update one phone receives (seat -1 for someone not seated). */
  update(seat: number, events: GameEvent[]): ServerMsg {
    return { t: "update", view: tableViewFor(this.s.game, seat), events, room: this.roomView() };
  }

  /** Hand over the events gathered since the last broadcast. */
  takeEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Nobody is seated any more. */
  get empty(): boolean {
    return this.s.seats.every((p) => p === null || p.kind === "bot");
  }
}
