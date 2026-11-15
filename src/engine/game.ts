// No-limit Texas Hold'em table rules: blinds, the button, betting rounds,
// side pots and showdown. Every function is pure: it takes a state and returns
// a new one plus a list of events the display can animate.

import { type Card, makeDeck } from "./cards";
import { type HandRank, describeWin, evaluateHand } from "./evaluate";
import { type PotAward, awardPots, buildPots } from "./pots";
import { Rng } from "./rng";

export type Personality = "human" | "cautious" | "loose" | "aggressive";
export type SeatStatus = "active" | "folded" | "allin" | "out";
export type ActionKind = "fold" | "check" | "call" | "bet" | "raise";
export type Street = "preflop" | "flop" | "turn" | "river" | "complete";

export interface LastAction {
  kind: ActionKind | "sb" | "bb";
  /** Total in front of the player on this street after the action. */
  amount: number;
  allIn: boolean;
}

export interface Seat {
  id: number;
  name: string;
  personality: Personality;
  stack: number;
  hole: Card[];
  /** Chips put in on the current street. */
  streetBet: number;
  /** Chips put in during the whole hand (drives side pots). */
  committed: number;
  status: SeatStatus;
  /** Has acted since the last full raise. */
  acted: boolean;
  lastAction: LastAction | null;
}

export interface PotResult extends PotAward {
  /** The winning hand for this pot (null when everyone else folded). */
  hand: HandRank | null;
  /** Name of the winning hand, with the deciding kicker when there was one. */
  handText: string | null;
}

export interface HandResult {
  showdown: boolean;
  pots: PotResult[];
  /** Best hand of every player who reached showdown, by seat. */
  hands: Record<number, HandRank>;
  /** Chips won, by seat (zero for losers). */
  won: number[];
  /** Total chips in play this hand. */
  total: number;
}

export interface HandState {
  number: number;
  dealer: number;
  sbSeat: number;
  bbSeat: number;
  deck: Card[];
  board: Card[];
  street: Street;
  toAct: number | null;
  currentBet: number;
  /** Size of the last full raise; a new raise must be at least this much more. */
  minRaise: number;
  result: HandResult | null;
}

export interface GameState {
  seats: Seat[];
  smallBlind: number;
  bigBlind: number;
  /** Button seat of the last hand (-1 before the first). */
  dealer: number;
  handNo: number;
  rngState: number;
  hand: HandState | null;
}

export type Action =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "raise"; to: number };

export type GameEvent =
  | { type: "handStart"; handNo: number; dealer: number }
  | { type: "blind"; seat: number; amount: number; kind: "sb" | "bb"; allIn: boolean }
  | { type: "deal"; seats: number[] }
  | { type: "action"; seat: number; kind: ActionKind; amount: number; added: number; allIn: boolean }
  | { type: "returned"; seat: number; amount: number }
  | { type: "street"; street: Exclude<Street, "preflop" | "complete">; cards: Card[] }
  | { type: "handEnd"; result: HandResult };

export interface LegalActions {
  canCheck: boolean;
  /** Chips needed to call (capped at the stack). Zero when checking is allowed. */
  toCall: number;
  canRaise: boolean;
  /** True when nobody has bet yet this street, so a raise is called a bet. */
  isBet: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface PlayerSetup {
  name: string;
  personality: Personality;
}

export interface GameOptions {
  players: PlayerSetup[];
  stack?: number;
  smallBlind?: number;
  bigBlind?: number;
  seed: number;
}

export function createGame(opts: GameOptions): GameState {
  const stack = opts.stack ?? 1000;
  return {
    seats: opts.players.map((p, id) => ({
      id, name: p.name, personality: p.personality, stack, hole: [], streetBet: 0,
      committed: 0, status: "active", acted: false, lastAction: null,
    })),
    smallBlind: opts.smallBlind ?? 5,
    bigBlind: opts.bigBlind ?? 10,
    dealer: -1,
    handNo: 0,
    rngState: opts.seed >>> 0,
    hand: null,
  };
}

/** True when no hand is running. */
export function isBetweenHands(state: GameState): boolean {
  return !state.hand || state.hand.street === "complete";
}

/** Reset a seat's stack between hands (rebuys). */
export function rebuy(state: GameState, seat: number, amount: number): GameState {
  if (!isBetweenHands(state)) throw new Error("Rebuys happen between hands");
  const s = structuredClone(state);
  const p = s.seats[seat]!;
  p.stack = amount;
  p.status = "active";
  return s;
}

/** Number of seats that can play a hand. */
export function playersWithChips(state: GameState): number {
  return state.seats.filter((p) => p.stack > 0).length;
}

function seatAfter(s: GameState, from: number, ok: (p: Seat) => boolean): number | null {
  const n = s.seats.length;
  for (let i = 1; i <= n; i++) {
    const p = s.seats[(((from + i) % n) + n) % n]!;
    if (ok(p)) return p.id;
  }
  return null;
}

/** Seat ids going clockwise starting just left of `from`. */
function clockwiseFrom(s: GameState, from: number): number[] {
  const n = s.seats.length;
  return Array.from({ length: n }, (_, i) => (from + 1 + i) % n);
}

function put(p: Seat, amount: number): number {
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.streetBet += a;
  p.committed += a;
  if (p.stack === 0 && p.status === "active") p.status = "allin";
  return a;
}

export interface StartOptions {
  /**
   * Exact deck order, for tests and demos. Hole cards go two at a time to
   * players in seat order (seat 0 first), then the next five cards are the board.
   */
  deck?: Card[];
}

export function startHand(prev: GameState, opts: StartOptions = {}): { state: GameState; events: GameEvent[] } {
  if (!isBetweenHands(prev)) throw new Error("A hand is already running");
  const s = structuredClone(prev);
  const events: GameEvent[] = [];

  for (const p of s.seats) {
    p.hole = [];
    p.streetBet = 0;
    p.committed = 0;
    p.acted = false;
    p.lastAction = null;
    p.status = p.stack > 0 ? "active" : "out";
  }
  const live = s.seats.filter((p) => p.status === "active");
  if (live.length < 2) throw new Error("Need at least two players with chips");

  s.handNo += 1;
  s.dealer = seatAfter(s, s.dealer, (p) => p.status === "active")!;
  const headsUp = live.length === 2;
  // Heads-up the button posts the small blind and acts first before the flop.
  const sbSeat = headsUp ? s.dealer : seatAfter(s, s.dealer, (p) => p.status === "active")!;
  const bbSeat = seatAfter(s, sbSeat, (p) => p.status === "active")!;

  let deck: Card[];
  if (opts.deck) deck = [...opts.deck];
  else {
    const rng = new Rng(s.rngState);
    deck = rng.shuffle(makeDeck());
    s.rngState = rng.state;
  }
  for (const p of live) p.hole = [deck.shift()!, deck.shift()!];

  const h: HandState = {
    number: s.handNo, dealer: s.dealer, sbSeat, bbSeat, deck, board: [], street: "preflop",
    toAct: null, currentBet: 0, minRaise: s.bigBlind, result: null,
  };
  s.hand = h;
  events.push({ type: "handStart", handNo: s.handNo, dealer: s.dealer });

  for (const [seat, kind, size] of [[sbSeat, "sb", s.smallBlind], [bbSeat, "bb", s.bigBlind]] as const) {
    const p = s.seats[seat]!;
    const amount = put(p, size);
    p.lastAction = { kind, amount, allIn: p.stack === 0 };
    events.push({ type: "blind", seat, amount, kind, allIn: p.stack === 0 });
  }
  events.push({ type: "deal", seats: live.map((p) => p.id) });
  h.currentBet = Math.max(...s.seats.map((p) => p.streetBet));

  h.toAct = nextToAct(s, bbSeat);
  if (h.toAct === null) endRound(s, events);
  return { state: s, events };
}

/** Next seat that still owes an action this street, or null when the round is over. */
function nextToAct(s: GameState, from: number): number | null {
  const h = s.hand!;
  const activeCount = s.seats.filter((p) => p.status === "active").length;
  return seatAfter(s, from, (p) => {
    if (p.status !== "active") return false;
    // Alone against all-in players and already matched: nothing left to decide.
    if (activeCount <= 1 && p.streetBet >= h.currentBet) return false;
    return !p.acted || p.streetBet < h.currentBet;
  });
}

export function legalActions(state: GameState, seat: number): LegalActions {
  const h = state.hand;
  const p = state.seats[seat];
  if (!h || !p) throw new Error("No hand running");
  const toCall = Math.min(Math.max(h.currentBet - p.streetBet, 0), p.stack);
  const othersActive = state.seats.some((o) => o.id !== seat && o.status === "active");
  const maxRaiseTo = p.streetBet + p.stack;
  // A player who already acted may not re-raise after only a short all-in.
  const canRaise = !p.acted && maxRaiseTo > h.currentBet && othersActive;
  return {
    canCheck: h.currentBet <= p.streetBet,
    toCall,
    canRaise,
    isBet: h.currentBet === 0,
    minRaiseTo: Math.min(h.currentBet + h.minRaise, maxRaiseTo),
    maxRaiseTo,
  };
}

export function applyAction(prev: GameState, seat: number, action: Action): { state: GameState; events: GameEvent[] } {
  const h0 = prev.hand;
  if (!h0 || h0.street === "complete") throw new Error("No hand running");
  if (h0.toAct !== seat) throw new Error(`It is not seat ${seat}'s turn`);
  const legal = legalActions(prev, seat);
  const s = structuredClone(prev);
  const h = s.hand!;
  const p = s.seats[seat]!;
  const events: GameEvent[] = [];

  let kind: ActionKind;
  let added = 0;
  switch (action.type) {
    case "fold":
      kind = "fold";
      p.status = "folded";
      break;
    case "check":
      if (!legal.canCheck) throw new Error("Cannot check facing a bet");
      kind = "check";
      break;
    case "call":
      if (legal.canCheck) throw new Error("Nothing to call");
      kind = "call";
      added = put(p, legal.toCall);
      break;
    case "raise": {
      if (!legal.canRaise) throw new Error("Raising is not allowed here");
      const to = Math.floor(action.to);
      const allIn = to === legal.maxRaiseTo;
      if (to > legal.maxRaiseTo || (to < legal.minRaiseTo && !allIn) || to <= h.currentBet) {
        throw new Error(`Raise to ${to} is outside ${legal.minRaiseTo} to ${legal.maxRaiseTo}`);
      }
      kind = legal.isBet ? "bet" : "raise";
      added = put(p, to - p.streetBet);
      const increment = to - h.currentBet;
      if (increment >= h.minRaise) {
        // A full raise reopens the betting for everyone else.
        h.minRaise = increment;
        for (const o of s.seats) if (o.id !== seat) o.acted = false;
      }
      h.currentBet = to;
      break;
    }
  }
  p.acted = true;
  const allIn = p.status === "allin";
  p.lastAction = { kind, amount: p.streetBet, allIn };
  events.push({ type: "action", seat, kind, amount: p.streetBet, added, allIn });

  const contenders = s.seats.filter((o) => o.status === "active" || o.status === "allin");
  if (contenders.length === 1) {
    returnUncalled(s, events);
    finish(s, events, false);
  } else {
    h.toAct = nextToAct(s, seat);
    if (h.toAct === null) endRound(s, events);
  }
  return { state: s, events };
}

/** Give back the part of the biggest bet that nobody matched. */
function returnUncalled(s: GameState, events: GameEvent[]): void {
  const sorted = [...s.seats].sort((a, b) => b.streetBet - a.streetBet);
  const top = sorted[0]!;
  const second = sorted[1]?.streetBet ?? 0;
  const extra = top.streetBet - second;
  if (extra <= 0) return;
  top.streetBet -= extra;
  top.committed -= extra;
  top.stack += extra;
  if (top.status === "allin") top.status = "active";
  if (top.lastAction) top.lastAction = { ...top.lastAction, amount: top.streetBet, allIn: false };
  events.push({ type: "returned", seat: top.id, amount: extra });
}

function endRound(s: GameState, events: GameEvent[]): void {
  const h = s.hand!;
  returnUncalled(s, events);
  for (;;) {
    for (const p of s.seats) {
      p.streetBet = 0;
      p.acted = false;
      if (p.status === "active" || p.status === "allin") p.lastAction = null;
    }
    h.currentBet = 0;
    h.minRaise = s.bigBlind;
    h.toAct = null;

    if (h.street === "river") {
      finish(s, events, true);
      return;
    }
    const next = h.street === "preflop" ? "flop" : h.street === "flop" ? "turn" : "river";
    const cards = h.deck.splice(0, next === "flop" ? 3 : 1);
    h.board.push(...cards);
    h.street = next;
    events.push({ type: "street", street: next, cards });

    // Betting continues only while two or more players still have chips.
    if (s.seats.filter((p) => p.status === "active").length >= 2) {
      h.toAct = nextToAct(s, h.dealer);
      if (h.toAct !== null) return;
    }
  }
}

function finish(s: GameState, events: GameEvent[], showdown: boolean): void {
  const h = s.hand!;
  const contenders = s.seats.filter((p) => p.status === "active" || p.status === "allin");
  const pots = buildPots(s.seats.map((p) => ({ seat: p.id, committed: p.committed, folded: !contenders.includes(p) })));

  const hands: Record<number, HandRank> = {};
  const scores = new Map<number, number>();
  if (showdown) {
    for (const p of contenders) {
      const hand = evaluateHand([...p.hole, ...h.board]);
      hands[p.id] = hand;
      scores.set(p.id, hand.score);
    }
  } else {
    for (const p of contenders) scores.set(p.id, 0);
  }

  const awards = awardPots(pots, scores, clockwiseFrom(s, h.dealer));
  const won = s.seats.map(() => 0);
  const results: PotResult[] = awards.map((a) => {
    a.winners.forEach((w, i) => (won[w]! += a.shares[i]!));
    const hand = showdown ? hands[a.winners[0]!]! : null;
    const beaten = a.eligible.filter((e) => !a.winners.includes(e)).map((e) => hands[e]!);
    return { ...a, hand, handText: hand ? describeWin(hand, beaten) : null };
  });
  for (const p of s.seats) p.stack += won[p.id]!;

  h.street = "complete";
  h.toAct = null;
  h.result = {
    showdown, pots: results, hands, won,
    total: s.seats.reduce((sum, p) => sum + p.committed, 0),
  };
  events.push({ type: "handEnd", result: h.result });
}

/** Everything in the middle: chips committed by all players this hand. */
export function potTotal(state: GameState): number {
  return state.seats.reduce((sum, p) => sum + p.committed, 0);
}

// ---------------------------------------------------------------------------
// What one player is allowed to know. Bots only ever receive this view: it has
// no deck and no other player's hole cards, so they cannot peek.

export interface PublicSeat {
  id: number;
  name: string;
  stack: number;
  streetBet: number;
  committed: number;
  status: SeatStatus;
}

export interface PlayerView {
  seat: number;
  hole: Card[];
  board: Card[];
  street: Street;
  dealer: number;
  bigBlind: number;
  pot: number;
  currentBet: number;
  minRaise: number;
  players: PublicSeat[];
  legal: LegalActions | null;
}

export function viewFor(state: GameState, seat: number): PlayerView {
  const h = state.hand;
  if (!h) throw new Error("No hand running");
  const me = state.seats[seat]!;
  return {
    seat,
    hole: me.hole.map((c) => ({ ...c })),
    board: h.board.map((c) => ({ ...c })),
    street: h.street,
    dealer: h.dealer,
    bigBlind: state.bigBlind,
    pot: potTotal(state),
    currentBet: h.currentBet,
    minRaise: h.minRaise,
    players: state.seats.map((p) => ({
      id: p.id, name: p.name, stack: p.stack, streetBet: p.streetBet,
      committed: p.committed, status: p.status,
    })),
    legal: h.toAct === seat ? legalActions(state, seat) : null,
  };
}
