// What one player's screen is allowed to show. The server sends each phone only
// its own TableView, so no phone ever receives the deck or another player's
// hole cards (other than cards turned face up at showdown).

import type { Card } from "./cards";
import {
  type GameEvent, type GameState, type HandResult, type LastAction, type LegalActions,
  type Personality, type SeatStatus, type Street, legalActions,
} from "./game";

export interface SeatView {
  id: number;
  name: string;
  /** "human" for people, otherwise the bot's style. */
  personality: Personality;
  stack: number;
  streetBet: number;
  committed: number;
  status: SeatStatus;
  lastAction: LastAction | null;
  /** How many hole cards the player holds (shown face down unless `hole` is filled). */
  cardCount: number;
  /** Your own cards, or cards turned face up at showdown. Otherwise empty. */
  hole: Card[];
}

export interface HandView {
  number: number;
  dealer: number;
  sbSeat: number;
  bbSeat: number;
  board: Card[];
  street: Street;
  toAct: number | null;
  currentBet: number;
  minRaise: number;
  result: HandResult | null;
}

export interface TableView {
  /** The viewer's seat, or -1 for someone watching. */
  me: number;
  seats: SeatView[];
  hand: HandView | null;
  smallBlind: number;
  bigBlind: number;
  /** Your legal actions when it's your turn. */
  legal: LegalActions | null;
}

export function tableViewFor(state: GameState, me: number): TableView {
  const h = state.hand;
  const showdown = !!h?.result?.showdown;
  return {
    me,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    seats: state.seats.map((p) => {
      const revealed = p.id === me || (showdown && p.status !== "folded" && !!h!.result!.hands[p.id]);
      return {
        id: p.id, name: p.name, personality: p.personality, stack: p.stack, streetBet: p.streetBet,
        committed: p.committed, status: p.status, lastAction: p.lastAction ? { ...p.lastAction } : null,
        cardCount: p.hole.length,
        hole: revealed ? p.hole.map((c) => ({ ...c })) : [],
      };
    }),
    hand: h
      ? {
          number: h.number, dealer: h.dealer, sbSeat: h.sbSeat, bbSeat: h.bbSeat,
          board: h.board.map((c) => ({ ...c })), street: h.street, toAct: h.toAct,
          currentBet: h.currentBet, minRaise: h.minRaise,
          result: h.result ? structuredClone(h.result) : null,
        }
      : null,
    legal: h && h.street !== "complete" && h.toAct === me ? legalActions(state, me) : null,
  };
}

export function viewBetweenHands(v: TableView): boolean {
  return !v.hand || v.hand.street === "complete";
}

/**
 * Renumber seats so the viewer is seat 0 and the rest follow clockwise. The
 * screen always draws you at the bottom, whichever seat you sit in.
 */
export function rotateView(view: TableView, events: GameEvent[]): { view: TableView; events: GameEvent[] } {
  const n = view.seats.length;
  const me = view.me;
  if (me <= 0 || n === 0) return { view, events };
  const r = (seat: number) => (seat - me + n) % n;
  const rn = (seat: number | null) => (seat === null ? null : r(seat));

  const result = (res: HandResult | null): HandResult | null => {
    if (!res) return null;
    const hands: HandResult["hands"] = {};
    for (const [k, v] of Object.entries(res.hands)) hands[r(Number(k))] = v;
    const won = new Array<number>(n).fill(0);
    res.won.forEach((w, seat) => (won[r(seat)] = w));
    return {
      ...res,
      hands,
      won,
      pots: res.pots.map((p) => ({ ...p, eligible: p.eligible.map(r), winners: p.winners.map(r) })),
    };
  };

  const seats = new Array<SeatView>(n);
  for (const s of view.seats) seats[r(s.id)] = { ...s, id: r(s.id) };
  const h = view.hand;
  return {
    view: {
      ...view,
      me: 0,
      seats,
      hand: h
        ? { ...h, dealer: r(h.dealer), sbSeat: r(h.sbSeat), bbSeat: r(h.bbSeat), toAct: rn(h.toAct), result: result(h.result) }
        : null,
    },
    events: events.map((e): GameEvent => {
      switch (e.type) {
        case "handStart": return { ...e, dealer: r(e.dealer) };
        case "blind": case "action": case "returned": return { ...e, seat: r(e.seat) };
        case "deal": return { ...e, seats: e.seats.map(r) };
        case "handEnd": return { ...e, result: result(e.result)! };
        default: return e;
      }
    }),
  };
}
