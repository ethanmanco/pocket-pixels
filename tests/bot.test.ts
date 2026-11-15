import { describe, expect, it } from "vitest";
import { parseCards } from "../src/engine/cards";
import { STYLES, decide, estimateEquity } from "../src/engine/bot";
import { type GameState, applyAction, createGame, legalActions, startHand, viewFor } from "../src/engine/game";
import { Rng } from "../src/engine/rng";

describe("estimateEquity", () => {
  const eq = (hole: string, board: string, opps: number, n = 4000) =>
    estimateEquity(parseCards(hole), parseCards(board), opps, n, new Rng(1));

  it("pocket aces win about 85% heads-up", () => {
    expect(eq("As Ah", "", 1)).toBeCloseTo(0.85, 1);
  });
  it("seven-two offsuit wins about a third heads-up", () => {
    expect(eq("7c 2d", "", 1)).toBeCloseTo(0.34, 1);
  });
  it("aces win less often against more players", () => {
    expect(eq("As Ah", "", 3)).toBeLessThan(eq("As Ah", "", 1));
  });
  it("the nuts on the river always wins", () => {
    expect(eq("As Ks", "Qs Js Ts 2d 3c", 3, 500)).toBe(1);
  });
  it("a board that plays for everyone is a tie", () => {
    expect(eq("2c 3d", "As Ks Qs Js Ts", 1, 500)).toBe(0.5);
  });
});

function botGame(personality: "cautious" | "loose" | "aggressive", players = 2): GameState {
  return createGame({
    players: Array.from({ length: players }, (_, i) => ({ name: `P${i}`, personality })),
    seed: 3,
  });
}

/** Play bot-vs-bot hands and count raise / call / fold choices. */
function sampleStyle(personality: "cautious" | "loose" | "aggressive", hands: number) {
  const rng = new Rng(11);
  let g = botGame(personality, 3);
  const counts = { raise: 0, call: 0, fold: 0, check: 0, preflopPlays: 0, preflopSpots: 0 };
  for (let i = 0; i < hands; i++) {
    for (const p of g.seats) if (p.stack < 100) g = { ...g, seats: g.seats.map((s) => (s.id === p.id ? { ...s, stack: 1000 } : s)) };
    g = startHand(g).state;
    while (g.hand!.street !== "complete") {
      const seat = g.hand!.toAct!;
      const view = viewFor(g, seat);
      const action = decide(view, STYLES[personality], rng, 120);
      const legal = legalActions(g, seat);
      if (action.type === "raise") {
        expect(legal.canRaise).toBe(true);
        expect(action.to).toBeGreaterThanOrEqual(Math.min(legal.minRaiseTo, legal.maxRaiseTo));
        expect(action.to).toBeLessThanOrEqual(legal.maxRaiseTo);
      }
      if (view.street === "preflop" && !legal.canCheck) {
        counts.preflopSpots++;
        if (action.type !== "fold") counts.preflopPlays++;
      }
      counts[action.type]++;
      g = applyAction(g, seat, action).state;
    }
  }
  return counts;
}

describe("decide", () => {
  it("always picks a legal action, for every personality", () => {
    for (const p of ["cautious", "loose", "aggressive"] as const) sampleStyle(p, 40);
  });

  it("personalities play differently", () => {
    const cautious = sampleStyle("cautious", 80);
    const loose = sampleStyle("loose", 80);
    const aggressive = sampleStyle("aggressive", 80);
    const raiseRate = (c: typeof cautious) => c.raise / (c.raise + c.call + c.fold + c.check);
    const playRate = (c: typeof cautious) => c.preflopPlays / c.preflopSpots;
    expect(raiseRate(aggressive)).toBeGreaterThan(raiseRate(cautious));
    expect(raiseRate(aggressive)).toBeGreaterThan(raiseRate(loose));
    expect(playRate(loose)).toBeGreaterThan(playRate(cautious));
  });

  it("checks a weak hand when it can rather than folding", () => {
    let { state } = startHand(botGame("cautious"), { deck: parseCards("2c 7d Ks Kd 9h 4s Jc 3d 5h") });
    state = applyAction(state, 0, { type: "call" }).state;
    // Seat 1 (big blind) may check: a bot must never fold for free.
    for (let i = 0; i < 30; i++) {
      const a = decide(viewFor(state, 1), STYLES.cautious, new Rng(i), 100);
      expect(a.type).not.toBe("fold");
    }
  });

  it("does not fold the nuts", () => {
    let { state } = startHand(botGame("cautious"), { deck: parseCards("As Ks 7c 2d Qs Js Ts 4h 9c") });
    state = applyAction(state, 0, { type: "call" }).state;
    state = applyAction(state, 1, { type: "check" }).state; // flop: Qs Js Ts, seat 0 has a royal flush
    state = applyAction(state, 1, { type: "raise", to: 20 }).state;
    for (let i = 0; i < 20; i++) {
      const a = decide(viewFor(state, 0), STYLES.cautious, new Rng(i), 200);
      expect(a.type).not.toBe("fold");
    }
  });
});
