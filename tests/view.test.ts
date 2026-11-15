import { describe, expect, it } from "vitest";
import { type Card, makeDeck, parseCards, sameCard } from "../src/engine/cards";
import { type Action, type GameState, applyAction, createGame, legalActions, rebuy, startHand } from "../src/engine/game";
import { Rng } from "../src/engine/rng";
import { rotateView, tableViewFor } from "../src/engine/view";

function game(players: number, stacks?: number[]): GameState {
  let g = createGame({ players: Array.from({ length: players }, (_, i) => ({ name: `P${i}`, personality: "human" as const })), seed: 5 });
  stacks?.forEach((s, i) => (g = rebuy(g, i, s)));
  return g;
}

function deckOf(holes: string, board: string): Card[] {
  const top = parseCards(`${holes} ${board}`);
  return [...top, ...makeDeck().filter((c) => !top.some((t) => sameCard(t, c)))];
}

function cardsIn(value: unknown): Card[] {
  const seen: Card[] = [];
  JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && "rank" in v && "suit" in v) seen.push(v as Card);
    return v;
  });
  return seen;
}

function play(g: GameState, ...actions: Action[]): GameState {
  for (const a of actions) g = applyAction(g, g.hand!.toAct!, a).state;
  return g;
}

describe("tableViewFor", () => {
  it("shows only your own hole cards and the board during a hand", () => {
    let g = startHand(game(4)).state;
    g = play(g, { type: "call" }, { type: "call" }, { type: "call" }, { type: "check" });
    for (const me of [0, 1, 2, 3]) {
      const v = tableViewFor(g, me);
      const allowed = [...g.seats[me]!.hole, ...g.hand!.board];
      expect(cardsIn(v).every((c) => allowed.some((a) => sameCard(a, c)))).toBe(true);
      expect(v.seats.filter((s) => s.id !== me).every((s) => s.hole.length === 0 && s.cardCount === 2)).toBe(true);
      expect(JSON.stringify(v)).not.toContain("deck");
    }
  });

  it("a watcher sees no hole cards at all", () => {
    const g = startHand(game(3)).state;
    expect(tableViewFor(g, -1).seats.every((s) => s.hole.length === 0)).toBe(true);
    expect(tableViewFor(g, -1).legal).toBeNull();
  });

  it("turns over the cards of players who reach showdown, but never folded cards", () => {
    let g = startHand(game(3), { deck: deckOf("Ah Kh 2c 7d 9s 9d", "Qh Jh 3s 4c 8d") }).state;
    // Seat 0 calls, seat 1 folds, seat 2 checks, then check it down.
    g = play(g, { type: "call" }, { type: "fold" }, { type: "check" });
    while (g.hand!.street !== "complete") g = play(g, { type: "check" });
    const v = tableViewFor(g, 2);
    expect(v.seats[0]!.hole).toHaveLength(2);
    expect(v.seats[1]!.hole).toHaveLength(0);
    expect(cardsIn(v).some((c) => sameCard(c, parseCards("2c")[0]!))).toBe(false);
  });

  it("does not show hands when everyone else folds", () => {
    let g = startHand(game(2)).state;
    g = play(g, { type: "fold" });
    expect(tableViewFor(g, 0).seats[1]!.hole).toHaveLength(0);
    expect(tableViewFor(g, 1).seats[0]!.hole).toHaveLength(0);
  });

  it("includes legal actions only for the player whose turn it is", () => {
    const g = startHand(game(3)).state;
    expect(tableViewFor(g, 0).legal).toEqual(legalActions(g, 0));
    expect(tableViewFor(g, 1).legal).toBeNull();
  });

  it("never leaks hidden cards over many random hands", () => {
    const rng = new Rng(3);
    let g = game(5);
    for (let hand = 0; hand < 60; hand++) {
      for (const p of g.seats) if (p.stack === 0) g = rebuy(g, p.id, 1000);
      g = startHand(g).state;
      while (g.hand!.street !== "complete") {
        for (const me of [-1, 0, 1, 2, 3, 4]) {
          const v = tableViewFor(g, me);
          const own = me >= 0 ? g.seats[me]!.hole : [];
          const allowed = [...own, ...g.hand!.board];
          expect(cardsIn(v).every((c) => allowed.some((a) => sameCard(a, c)))).toBe(true);
        }
        const seat = g.hand!.toAct!;
        const legal = legalActions(g, seat);
        const roll = rng.next();
        const a: Action = legal.canRaise && roll < 0.2 ? { type: "raise", to: legal.minRaiseTo }
          : roll < 0.3 && !legal.canCheck ? { type: "fold" } : legal.canCheck ? { type: "check" } : { type: "call" };
        g = applyAction(g, seat, a).state;
      }
    }
  });
});

describe("rotateView", () => {
  it("puts the viewer at seat 0 and renumbers everything clockwise", () => {
    const start = startHand(game(4));
    const v = tableViewFor(start.state, 2);
    const { view, events } = rotateView(v, start.events);
    expect(view.me).toBe(0);
    expect(view.seats.map((s) => s.name)).toEqual(["P2", "P3", "P0", "P1"]);
    expect(view.seats.map((s) => s.id)).toEqual([0, 1, 2, 3]);
    expect(view.seats[0]!.hole).toEqual(start.state.seats[2]!.hole);
    // Original: dealer 0, small blind 1, big blind 2, seat 3 to act.
    expect(view.hand).toMatchObject({ dealer: 2, sbSeat: 3, bbSeat: 0, toAct: 1 });
    const blinds = events.filter((e) => e.type === "blind").map((e) => (e.type === "blind" ? e.seat : -1));
    expect(blinds).toEqual([3, 0]);
  });

  it("renumbers results, winnings and pots", () => {
    let g = startHand(game(3), { deck: deckOf("Ah Kh 2c 7d 9s 9d", "Qh Jh 3s 4c 8d") }).state;
    g = play(g, { type: "call" }, { type: "fold" }, { type: "check" });
    let last = applyAction(g, g.hand!.toAct!, { type: "check" });
    while (last.state.hand!.street !== "complete") last = applyAction(last.state, last.state.hand!.toAct!, { type: "check" });
    const { view, events } = rotateView(tableViewFor(last.state, 2), last.events);
    // Seat 2 becomes seat 0 and seat 0 becomes seat 1; both reach showdown.
    const r = view.hand!.result!;
    expect(r.won[0]).toBe(last.state.hand!.result!.won[2]);
    expect(r.won[1]).toBe(last.state.hand!.result!.won[0]);
    expect(Object.keys(r.hands).sort()).toEqual(["0", "1"]);
    const end = events.find((e) => e.type === "handEnd");
    expect(end && end.type === "handEnd" ? end.result.won : null).toEqual(r.won);
  });

  it("leaves seat 0 unchanged", () => {
    const start = startHand(game(3));
    const v = tableViewFor(start.state, 0);
    expect(rotateView(v, start.events).view).toBe(v);
  });
});
