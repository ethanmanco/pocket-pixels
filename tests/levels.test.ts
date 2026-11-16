import { describe, expect, it } from "vitest";
import { type Level, type Notes, decideAtLevel, hasDraw, preflopPercentile, updateNotes } from "../src/engine/brain";
import { parseCards } from "../src/engine/cards";
import { type GameState, applyAction, createGame, legalActions, rebuy, startHand, viewFor } from "../src/engine/game";
import { Rng } from "../src/engine/rng";

// Environment variables for the optional ladder run (Node types are not part of this project).
declare const process: { env: Record<string, string | undefined> };

const c = (s: string) => parseCards(s);

describe("starting hand chart", () => {
  it("ranks aces first and seven-two near the bottom", () => {
    const [aa1, aa2] = c("As Ah");
    const [ak1, ak2] = c("As Ks");
    const [s1, s2] = c("7c 2d");
    expect(preflopPercentile(aa1!, aa2!)).toBeLessThan(0.01);
    expect(preflopPercentile(ak1!, ak2!)).toBeLessThan(0.05);
    expect(preflopPercentile(s1!, s2!)).toBeGreaterThan(0.9);
  });

  it("finds flush and open-ended straight draws", () => {
    expect(hasDraw(c("Ah 9h"), c("2h 7h Kc"))).toBe(true);
    expect(hasDraw(c("8c 9d"), c("7s 6h Kc"))).toBe(true);
    expect(hasDraw(c("8c 2d"), c("Js Qh Kc"))).toBe(false);
    expect(hasDraw(c("Ah 9h"), c("2h 7h Kc 4d 5s"))).toBe(false); // no draws on the river
  });
});

/**
 * Heads-up duplicate match: the same shuffled decks are played twice with the
 * seats swapped, so the cards are identical for both players and only their
 * decisions make the difference. Returns A's chips won per 100 hands.
 */
function duplicateMatch(a: Level, b: Level, hands: number, seed: number): number {
  let net = 0;
  for (const swap of [false, true]) {
    const levels: Level[] = swap ? [b, a] : [a, b];
    const aSeat = swap ? 1 : 0;
    let g: GameState = createGame({
      players: [{ name: "P0", personality: "steady" }, { name: "P1", personality: "steady" }],
      seed,
    });
    const rngs = [new Rng(seed + 11), new Rng(seed + 29)];
    const notes: Notes[] = [{}, {}];
    for (let i = 0; i < hands; i++) {
      g = rebuy(rebuy(g, 0, 1000), 1, 1000);
      g = startHand(g).state;
      while (g.hand!.street !== "complete") {
        const seat = g.hand!.toAct!;
        const action = decideAtLevel(viewFor(g, seat), "steady", levels[seat]!, rngs[seat]!, notes[seat]);
        g = applyAction(g, seat, action).state;
      }
      for (const n of notes) updateNotes(n, g.hand!.history, [0, 1]);
      net += g.seats[aSeat]!.stack - 1000;
    }
  }
  return (net / (hands * 2)) * 100;
}

describe("skill levels", () => {
  it("every level always makes a legal move", () => {
    const rng = new Rng(4);
    for (const level of ["easy", "regular", "hard", "insane"] as Level[]) {
      let g = createGame({ players: Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, personality: "aggressive" as const })), seed: 9 });
      const notes: Notes = {};
      for (let hand = 0; hand < 12; hand++) {
        for (const p of g.seats) if (p.stack < 50) g = rebuy(g, p.id, 1000);
        g = startHand(g).state;
        while (g.hand!.street !== "complete") {
          const seat = g.hand!.toAct!;
          const legal = legalActions(g, seat);
          const a = decideAtLevel(viewFor(g, seat), "aggressive", level, rng, notes);
          if (a.type === "raise") {
            expect(legal.canRaise).toBe(true);
            expect(a.to).toBeLessThanOrEqual(legal.maxRaiseTo);
            expect(a.to >= legal.minRaiseTo || a.to === legal.maxRaiseTo).toBe(true);
          }
          if (a.type === "check") expect(legal.canCheck).toBe(true);
          g = applyAction(g, seat, a).state;
        }
        updateNotes(notes, g.hand!.history, g.seats.map((p) => p.id));
      }
    }
  });

  // The full ladder takes a few minutes, so it runs only when asked:
  //   LADDER=1 npx vitest run tests/levels.test.ts
  it.runIf(process.env.LADDER)("each level beats the one below it", { timeout: 1_800_000 }, () => {
    const hands = Number(process.env.LADDER_HANDS ?? 600);
    const pairs: [Level, Level][] = [["regular", "easy"], ["hard", "regular"], ["insane", "hard"], ["insane", "regular"], ["hard", "easy"]];
    for (const [a, b] of pairs) {
      const results = [1, 2].map((s) => duplicateMatch(a, b, hands, s * 1000));
      const avg = (results[0]! + results[1]!) / 2;
      console.log(`${a} vs ${b}: ${avg.toFixed(1)} chips per 100 hands (${results.map((r) => r.toFixed(1)).join(", ")})`);
      expect(avg).toBeGreaterThan(0);
    }
  });
});
