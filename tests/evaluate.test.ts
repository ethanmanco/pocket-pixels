import { describe, expect, it } from "vitest";
import { cardCode, makeDeck, parseCards } from "../src/engine/cards";
import {
  CATEGORY_NAMES, FLUSH, FOUR_OF_A_KIND, FULL_HOUSE, HIGH_CARD, PAIR, STRAIGHT,
  STRAIGHT_FLUSH, THREE_OF_A_KIND, TWO_PAIR, categoryOf, describeWin, evaluateHand, score7,
} from "../src/engine/evaluate";
import { Rng } from "../src/engine/rng";

const ev = (codes: string) => evaluateHand(parseCards(codes));
const best5 = (codes: string) => ev(codes).cards.map(cardCode).join(" ");
/** Compare two hands: 1 if a wins, -1 if b wins, 0 for a tie. */
const cmp = (a: string, b: string) => Math.sign(ev(a).score - ev(b).score);

describe("every hand category", () => {
  const cases: [string, number, string][] = [
    ["As Kd 9h 7c 4s 3d 2h", HIGH_CARD, "High card, ace"],
    ["Ks Kd 9h 7c 4s 3d 2h", PAIR, "Pair of kings"],
    ["Ks Kd 9h 9c 4s 3d 2h", TWO_PAIR, "Two pair, kings and nines"],
    ["7s 7d 7h Kc 4s 3d 2h", THREE_OF_A_KIND, "Three of a kind, sevens"],
    ["9s 8d 7h 6c 5s Kd 2h", STRAIGHT, "Straight, nine high"],
    ["Kh Jh 9h 6h 2h As 3d", FLUSH, "Flush, king high"],
    ["7s 7d 7h Kc Ks 3d 2h", FULL_HOUSE, "Full house, sevens full of kings"],
    ["Qs Qd Qh Qc 4s 3d 2h", FOUR_OF_A_KIND, "Four of a kind, queens"],
    ["9h 8h 7h 6h 5h Kd 2c", STRAIGHT_FLUSH, "Straight flush, nine high"],
    ["Ah Kh Qh Jh Th 2d 3c", STRAIGHT_FLUSH, "Royal flush"],
  ];
  for (const [codes, category, name] of cases) {
    it(`${CATEGORY_NAMES[category]}: ${codes}`, () => {
      const h = ev(codes);
      expect(h.category).toBe(category);
      expect(h.name).toBe(name);
      expect(h.cards).toHaveLength(5);
    });
  }

  it("ranks the categories in the right order", () => {
    const scores = cases.slice(0, 9).map(([codes]) => ev(codes).score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThan(scores[i - 1]!);
  });
});

describe("the wheel (A-2-3-4-5)", () => {
  it("is a five-high straight with the ace played low", () => {
    const h = ev("As 2d 3h 4c 5s Kd Qh");
    expect(h.category).toBe(STRAIGHT);
    expect(h.name).toBe("Straight, five high");
    expect(h.cards.map(cardCode).join(" ")).toBe("5s 4c 3h 2d As");
  });
  it("loses to a six-high straight", () => {
    expect(cmp("As 2d 3h 4c 5s", "2d 3h 4c 5s 6h")).toBe(-1);
  });
  it("beats three of a kind", () => {
    expect(cmp("As 2d 3h 4c 5s", "Ks Kd Kh 7c 2h")).toBe(1);
  });
  it("counts as a steel wheel straight flush", () => {
    const h = ev("Ad 2d 3d 4d 5d 9c 9s");
    expect(h.category).toBe(STRAIGHT_FLUSH);
    expect(h.name).toBe("Straight flush, five high");
    expect(cmp("Ad 2d 3d 4d 5d", "2c 3c 4c 5c 6c")).toBe(-1);
  });
  it("does not wrap around (Q-K-A-2-3 is not a straight)", () => {
    expect(ev("Qs Kd Ah 2c 3s").category).toBe(HIGH_CARD);
  });
  it("picks the higher straight when six cards run", () => {
    expect(ev("As 2d 3h 4c 5s 6d 9h").name).toBe("Straight, six high");
  });
});

describe("kickers", () => {
  it("high card compares all five cards", () => {
    expect(cmp("As Kd 9h 7c 4s", "As Kd 9h 7c 3s")).toBe(1);
    expect(cmp("As Kd 9h 7c 4s", "Ac Kh 9s 7d 4h")).toBe(0);
  });
  it("pair uses three kickers in order", () => {
    expect(cmp("Ks Kd Ah 7c 4s", "Kh Kc Qh 9c 8s")).toBe(1);
    expect(cmp("Ks Kd Ah 7c 4s", "Kh Kc Ad 6c 5s")).toBe(1);
    expect(cmp("Ks Kd Ah 7c 4s", "Kh Kc Ad 7d 3s")).toBe(1);
  });
  it("two pair: top pair, then bottom pair, then kicker", () => {
    expect(cmp("Ks Kd 3h 3c 2s", "Qs Qd Jh Jc Ac")).toBe(1);
    expect(cmp("Ks Kd 9h 9c 2s", "Kh Kc 8h 8c Ac")).toBe(1);
    expect(cmp("Ks Kd 9h 9c 5s", "Kh Kc 9s 9d 4c")).toBe(1);
  });
  it("two pair with three pairs on seven cards keeps the best kicker", () => {
    // Pairs of kings, nines and fours: the fours do not play, the ace kicks.
    const h = ev("Ks Kd 9h 9c 4s 4d Ah");
    expect(h.name).toBe("Two pair, kings and nines");
    expect(h.ranks).toEqual([13, 9, 14]);
    // Here the third pair's four beats the lone three as the kicker.
    expect(ev("Ks Kd 9h 9c 4s 4d 3h").ranks).toEqual([13, 9, 4]);
  });
  it("three of a kind uses two kickers", () => {
    expect(cmp("7s 7d 7h Ac 2s", "7c 7d 7h Kc Qs")).toBe(1);
    expect(cmp("7s 7d 7h Ac 3s", "7c 7d 7h Ad 2s")).toBe(1);
  });
  it("four of a kind uses one kicker", () => {
    expect(cmp("Qs Qd Qh Qc As", "Qs Qd Qh Qc Ks")).toBe(1);
    expect(best5("Qs Qd Qh Qc 4s Ad 2h")).toBe("Qs Qd Qh Qc Ad");
  });
  it("flush compares all five cards", () => {
    expect(cmp("Kh Jh 9h 6h 3h", "Kd Jd 9d 6d 2d")).toBe(1);
    expect(cmp("Kh Jh 9h 6h 3h", "Ks Js 9s 6s 3s")).toBe(0);
  });
  it("full house: trips first, then pair", () => {
    expect(cmp("3s 3d 3h 2c 2s", "2c 2d 2h Ac As")).toBe(1);
    expect(cmp("Ts Td Th Ac As", "Ts Td Th Kc Ks")).toBe(1);
  });
  it("full house from two sets of trips uses the higher as trips", () => {
    expect(ev("9s 9d 9h 5c 5s 5d 2h").name).toBe("Full house, nines full of fives");
  });
  it("describes the deciding kicker", () => {
    const winner = ev("Ks Kd Ah 7c 4s");
    const loser = ev("Kh Kc Qh 9c 8s");
    expect(describeWin(winner, [loser])).toBe("Pair of kings, ace kicker");
    expect(describeWin(winner, [ev("Qs Qd Ah 7c 4s")])).toBe("Pair of kings");
    expect(describeWin(ev("Ks Kd 9h 9c 5s"), [ev("Kh Kc 9s 9d 4c")])).toBe(
      "Two pair, kings and nines, five kicker",
    );
  });
});

describe("ties and the board playing", () => {
  it("is a tie when the board is the best hand for both", () => {
    const board = "As Ks Qs Js Ts";
    expect(cmp(`${board} 2h 3d`, `${board} 4c 5c`)).toBe(0);
  });
  it("is a tie when only suits differ", () => {
    expect(cmp("9s 8d 7h 6c 5s", "9h 8h 7d 6d 5c")).toBe(0);
  });
  it("ignores a sixth and seventh card that cannot improve the hand", () => {
    expect(cmp("Ks Kd 9h 7c 4s 3d 2h", "Ks Kd 9h 7c 4s")).toBe(0);
  });
});

describe("best five cards", () => {
  it("picks the flush cards out of seven", () => {
    expect(best5("Kh Jh 9h 6h 2h 3h As")).toBe("Kh Jh 9h 6h 3h");
  });
  it("prefers a straight flush over a higher plain flush", () => {
    const h = ev("Ah 9h 8h 7h 6h 5h Kd");
    expect(h.name).toBe("Straight flush, nine high");
  });
});

describe("score7 agrees with the full evaluator", () => {
  it("matches on 5000 random hands of 5, 6 and 7 cards", () => {
    const rng = new Rng(12345);
    for (let i = 0; i < 5000; i++) {
      const deck = rng.shuffle(makeDeck());
      const n = 5 + (i % 3);
      const cards = deck.slice(0, n);
      const full = evaluateHand(cards);
      const fast = score7(cards);
      if (fast !== full.score) throw new Error(`Mismatch on ${cards.map(cardCode).join(" ")}`);
      expect(categoryOf(fast)).toBe(full.category);
    }
  });
  it("matches on hand-picked edge cases", () => {
    for (const codes of [
      "As 2d 3h 4c 5s Kd Qh", "Ad 2d 3d 4d 5d 9c 9s", "9s 9d 9h 5c 5s 5d 2h",
      "Ks Kd 9h 9c 4s 4d Ah", "Qs Qd Qh Qc 4s 4d 4h", "Ah 9h 8h 7h 6h 5h Kd",
      "Kh Jh 9h 6h 2h 3h As", "As Ks Qs Js Ts 9s 8s",
    ]) {
      expect(score7(parseCards(codes))).toBe(ev(codes).score);
    }
  });
});
