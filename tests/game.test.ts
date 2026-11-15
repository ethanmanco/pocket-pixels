import { describe, expect, it } from "vitest";
import { type Card, cardCode, makeDeck, parseCards, sameCard } from "../src/engine/cards";
import {
  type Action, type GameEvent, type GameState, applyAction, createGame, legalActions,
  potTotal, rebuy, startHand, viewFor,
} from "../src/engine/game";
import { Rng } from "../src/engine/rng";

const NAMES = ["You", "Pebble", "Juniper", "Blaze", "Rook", "Extra"];

function newGame(players: number, stacks?: number[]): GameState {
  let g = createGame({
    players: NAMES.slice(0, players).map((name, i) => ({ name, personality: i === 0 ? "human" : "cautious" })),
    seed: 7,
  });
  stacks?.forEach((amount, seat) => (g = rebuy(g, seat, amount)));
  return g;
}

/** Deck with the given hole cards (seat order) and board on top, the rest after. */
function deckOf(holes: string, board: string): Card[] {
  const top = parseCards(`${holes} ${board}`);
  return [...top, ...makeDeck().filter((c) => !top.some((t) => sameCard(t, c)))];
}

const F: Action = { type: "fold" };
const X: Action = { type: "check" };
const C: Action = { type: "call" };
const R = (to: number): Action => ({ type: "raise", to });

/** Apply actions in turn order, collecting events. */
function play(state: GameState, ...actions: Action[]): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  for (const a of actions) {
    const seat = state.hand!.toAct;
    if (seat === null) throw new Error(`No one to act for ${JSON.stringify(a)}`);
    const r = applyAction(state, seat, a);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

const total = (g: GameState) => g.seats.reduce((s, p) => s + p.stack, 0) + (g.hand?.street === "complete" ? 0 : potTotal(g));
const stacks = (g: GameState) => g.seats.map((p) => p.stack);

describe("blinds, the button and turn order", () => {
  it("heads-up: the button posts the small blind and acts first before the flop", () => {
    const { state } = startHand(newGame(2));
    const h = state.hand!;
    expect(h.dealer).toBe(0);
    expect(h.sbSeat).toBe(0);
    expect(h.bbSeat).toBe(1);
    expect(stacks(state)).toEqual([995, 990]);
    expect(h.toAct).toBe(0);
  });

  it("heads-up: the big blind gets an option, then acts first after the flop", () => {
    let { state } = startHand(newGame(2));
    state = play(state, C).state;
    expect(state.hand!.toAct).toBe(1);
    expect(legalActions(state, 1)).toMatchObject({ canCheck: true, canRaise: true });
    state = play(state, X).state;
    expect(state.hand!.street).toBe("flop");
    expect(state.hand!.board).toHaveLength(3);
    expect(state.hand!.toAct).toBe(1);
  });

  it("four players: small blind left of the button, first to act left of the big blind", () => {
    let { state } = startHand(newGame(4));
    expect(state.hand).toMatchObject({ dealer: 0, sbSeat: 1, bbSeat: 2, toAct: 3 });
    state = play(state, C, C, C, X).state;
    expect(state.hand!.street).toBe("flop");
    expect(state.hand!.toAct).toBe(1);
  });

  it("moves the button each hand and skips players with no chips", () => {
    let g = newGame(4, [1000, 1000, 0, 1000]);
    const first = startHand(g).state;
    expect(first.hand!.dealer).toBe(0);
    expect(first.hand).toMatchObject({ sbSeat: 1, bbSeat: 3 });
    g = play(first, F, F).state; // everyone folds to the big blind
    const second = startHand(g).state;
    expect(second.hand!.dealer).toBe(1);
    expect(second.seats[2]!.status).toBe("out");
    expect(second.seats[2]!.hole).toEqual([]);
  });
});

describe("betting rules", () => {
  it("everyone folding to the big blind returns the unmatched part of the blind", () => {
    const { state } = play(startHand(newGame(3)).state, F, F);
    expect(state.hand!.street).toBe("complete");
    expect(state.hand!.result!.showdown).toBe(false);
    expect(stacks(state)).toEqual([1000, 995, 1005]);
  });

  it("a raise must be at least the size of the last raise", () => {
    let { state } = startHand(newGame(3));
    expect(legalActions(state, 0)).toMatchObject({ minRaiseTo: 20, maxRaiseTo: 1000, isBet: false });
    state = play(state, R(30)).state; // raise of 20
    expect(legalActions(state, 1).minRaiseTo).toBe(50);
    expect(() => play(state, R(45))).toThrow();
    state = play(state, R(100)).state; // raise of 70
    expect(legalActions(state, 2).minRaiseTo).toBe(170);
  });

  it("the first bet on a later street is called a bet with a minimum of the big blind", () => {
    let { state } = startHand(newGame(2));
    state = play(state, C, X).state;
    expect(legalActions(state, 1)).toMatchObject({ isBet: true, minRaiseTo: 10, canCheck: true });
    const r = play(state, R(40));
    expect(r.events[0]).toMatchObject({ type: "action", kind: "bet", amount: 40 });
  });

  it("allows an all-in for less than a minimum raise", () => {
    const { state } = startHand(newGame(2, [1000, 15]));
    // Seat 1 is the big blind with 5 behind; seat 0 raises, seat 1 can only shove 15.
    const after = play(state, R(40)).state;
    expect(legalActions(after, 1)).toMatchObject({ toCall: 5, canRaise: false });
  });

  it("a short all-in raise does not reopen betting for players who already acted", () => {
    let { state } = startHand(newGame(3, [1000, 1000, 45]));
    // Button (seat 0) raises to 30, small blind calls, big blind shoves 45 (a raise of only 15).
    state = play(state, R(30), C, R(45)).state;
    expect(state.hand!.toAct).toBe(0);
    expect(legalActions(state, 0)).toMatchObject({ toCall: 15, canRaise: false });
    state = play(state, C).state;
    expect(legalActions(state, 1)).toMatchObject({ toCall: 15, canRaise: false });
    state = play(state, C).state;
    expect(state.hand!.street).toBe("flop");
  });

  it("a full all-in raise does reopen betting", () => {
    let { state } = startHand(newGame(3, [1000, 1000, 60]));
    state = play(state, R(30), C, R(60)).state; // raise of 30 is a full raise
    expect(legalActions(state, 0)).toMatchObject({ toCall: 30, canRaise: true, minRaiseTo: 90 });
  });

  it("rejects acting out of turn and checking facing a bet", () => {
    const { state } = startHand(newGame(3));
    expect(() => applyAction(state, 1, C)).toThrow();
    expect(() => applyAction(state, 0, X)).toThrow();
  });

  it("a big blind all-in for less than the small blind still finishes the hand", () => {
    const { state } = startHand(newGame(2, [1000, 4]));
    expect(state.hand!.street).toBe("complete");
    expect(state.hand!.board).toHaveLength(5);
    expect(total(state)).toBe(1004);
  });
});

describe("showdown", () => {
  it("names the winning hand and its five cards", () => {
    let { state } = startHand(newGame(2), { deck: deckOf("Kh Qh 9c 9d", "Ah 7h 2h 9s 3c") });
    state = play(state, C, X, X, X, X, X, X, X).state;
    const r = state.hand!.result!;
    expect(r.showdown).toBe(true);
    expect(r.pots[0]!.winners).toEqual([0]);
    expect(r.pots[0]!.handText).toBe("Flush, ace high");
    expect(r.pots[0]!.hand!.cards.map(cardCode)).toEqual(["Ah", "Kh", "Qh", "7h", "2h"]);
    expect(r.hands[1]!.name).toBe("Three of a kind, nines");
    expect(stacks(state)).toEqual([1010, 990]);
  });

  it("mentions the kicker when it decided the pot", () => {
    let { state } = startHand(newGame(2), { deck: deckOf("Ac 3d Qc 4d", "Ks Kd 8h 6c 2s") });
    state = play(state, C, X, X, X, X, X, X, X).state;
    expect(state.hand!.result!.pots[0]!.handText).toBe("Pair of kings, ace kicker");
  });

  it("splits the pot when the board plays, odd chip left of the button", () => {
    let { state } = startHand(newGame(3), { deck: deckOf("2c 3d 4c 5d 6c 7d", "As Ks Qs Js Ts") });
    // Button calls, small blind folds, big blind checks, then checks to showdown.
    state = play(state, C, F, X, X, X, X, X, X, X).state;
    const pot = state.hand!.result!.pots[0]!;
    expect(pot.amount).toBe(25);
    expect(pot.winners).toEqual([2, 0]);
    expect(pot.shares).toEqual([13, 12]);
    expect(stacks(state)).toEqual([1002, 995, 1003]);
  });

  it("side pots with three all-ins of different sizes", () => {
    let { state } = startHand(newGame(4, [1000, 100, 300, 600]), {
      // Seat 1 has quads, seat 2 aces and kings, seat 3 queens and kings, seat 0 one pair.
      deck: deckOf("8s 9s Ks Kc As Ah Qs Qh", "Kh Kd 7c 2s 3d"),
    });
    // Seat 3 shoves 600, button calls, both blinds call all-in for less.
    const r = play(state, R(600), C, C, C);
    state = r.state;
    expect(state.hand!.board).toHaveLength(5);
    const result = state.hand!.result!;
    expect(result.pots.map((p) => [p.amount, p.eligible.sort(), p.winners])).toEqual([
      [400, [0, 1, 2, 3], [1]],
      [600, [0, 2, 3], [2]],
      [600, [0, 3], [3]],
    ]);
    expect(stacks(state)).toEqual([400, 400, 600, 600]);
    expect(r.events.filter((e) => e.type === "street")).toHaveLength(3);
  });

  it("a short stack can win the main pot while a bigger stack wins the side pot", () => {
    let { state } = startHand(newGame(3, [1000, 1000, 200]), {
      deck: deckOf("Kd Kc Qd Qc As Ah", "7s 8d 2c 4h 9s"),
    });
    // Button shoves, small blind calls, big blind calls all-in for 200.
    state = play(state, R(1000), C, C).state;
    const result = state.hand!.result!;
    expect(result.pots.map((p) => [p.amount, p.winners])).toEqual([
      [600, [2]],
      [1600, [0]],
    ]);
    expect(stacks(state)).toEqual([1600, 0, 600]);
  });

  it("returns the part of an all-in that nobody could call", () => {
    let { state } = startHand(newGame(2, [1000, 400]), { deck: deckOf("2c 7d Ac Ad", "Ks Qd 9h 5c 3s") });
    const r = play(state, R(1000), C);
    state = r.state;
    expect(r.events).toContainEqual({ type: "returned", seat: 0, amount: 600 });
    expect(state.hand!.result!.pots).toHaveLength(1);
    expect(state.hand!.result!.pots[0]!.amount).toBe(800);
    expect(stacks(state)).toEqual([600, 800]);
  });

  it("a fold on the turn ends the hand without showing cards", () => {
    let { state } = startHand(newGame(2));
    state = play(state, C, X, R(20), C, R(50), F).state;
    const result = state.hand!.result!;
    expect(result.showdown).toBe(false);
    expect(result.hands).toEqual({});
    expect(result.won).toEqual([0, 60]); // the 50 turn bet came back
    expect(stacks(state)).toEqual([970, 1030]);
  });
});

describe("players only see what they should", () => {
  it("a player's view has no deck and no other player's cards", () => {
    let { state } = startHand(newGame(4));
    state = play(state, C, C, C, X).state;
    for (const seat of [0, 1, 2, 3]) {
      const view = viewFor(state, seat);
      const seen: Card[] = [];
      JSON.stringify(view, (_k, v) => {
        if (v && typeof v === "object" && "rank" in v && "suit" in v) seen.push(v as Card);
        return v;
      });
      const allowed = [...state.seats[seat]!.hole, ...state.hand!.board];
      expect(seen.every((c) => allowed.some((a) => sameCard(a, c)))).toBe(true);
      expect(seen).toHaveLength(2 + 3);
      expect(JSON.stringify(view)).not.toContain("deck");
    }
  });

  it("the view lists legal actions only on the player's own turn", () => {
    const { state } = startHand(newGame(3));
    expect(viewFor(state, 0).legal).not.toBeNull();
    expect(viewFor(state, 1).legal).toBeNull();
  });
});

describe("random play never breaks the rules", () => {
  it("keeps every chip over 500 random hands at 2 to 6 players", () => {
    const rng = new Rng(99);
    for (const players of [2, 3, 4, 5, 6]) {
      let g = newGame(players);
      const start = total(g);
      for (let hand = 0; hand < 100; hand++) {
        for (const p of g.seats) if (p.stack === 0) g = rebuy(g, p.id, 1000);
        const startTotal = total(g);
        g = startHand(g).state;
        let guard = 0;
        while (g.hand!.street !== "complete") {
          const seat = g.hand!.toAct!;
          const legal = legalActions(g, seat);
          const roll = rng.next();
          let a: Action;
          if (legal.canRaise && roll < 0.25) {
            a = R(legal.minRaiseTo + Math.floor(rng.next() * (legal.maxRaiseTo - legal.minRaiseTo + 1)));
          } else if (roll < 0.35 && !legal.canCheck) a = F;
          else a = legal.canCheck ? X : C;
          g = applyAction(g, seat, a).state;
          expect(total(g)).toBe(startTotal);
          if (++guard > 200) throw new Error("Hand did not finish");
        }
        expect(g.seats.every((p) => p.stack >= 0)).toBe(true);
        const r = g.hand!.result!;
        expect(r.pots.reduce((s, p) => s + p.amount, 0)).toBe(r.total);
        expect(r.won.reduce((s, w) => s + w, 0)).toBe(r.total);
        expect(total(g)).toBe(startTotal);
      }
      expect(start).toBe(players * 1000);
    }
  });
});

describe("five players", () => {
  it("posts blinds left of the button and starts with the player after the big blind", () => {
    let { state } = startHand(newGame(5));
    expect(state.hand).toMatchObject({ dealer: 0, sbSeat: 1, bbSeat: 2, toAct: 3 });
    state = play(state, C, C, C, C, X).state;
    expect(state.hand!.street).toBe("flop");
    expect(state.hand!.toAct).toBe(1);
  });

  it("splits side pots correctly with two all-ins and two callers", () => {
    let { state } = startHand(newGame(5, [1000, 1000, 1000, 150, 400]), {
      // Seat 3 (150) has the best hand, seat 4 (400) second, seat 0 third, seat 1 worst.
      deck: deckOf("Qs Qh 2c 3d Kc 4d As Ah Ks Kh", "Ad Kd 8c 7h 2s"),
    });
    // Seat 3 shoves 150, seat 4 shoves 400, button calls 400, small blind calls, big blind folds.
    state = play(state, R(150), R(400), C, C, F).state;
    // Two players still have chips, so they check it down.
    state = play(state, X, X, X, X, X, X).state;
    const r = state.hand!.result!;
    expect(r.pots.map((p) => [p.amount, p.winners])).toEqual([
      [150 * 4 + 10, [3]],
      [250 * 3, [4]],
    ]);
    expect(stacks(state)).toEqual([600, 600, 990, 610, 750]);
  });
});
