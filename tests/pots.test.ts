import { describe, expect, it } from "vitest";
import { awardPots, buildPots } from "../src/engine/pots";

const c = (seat: number, committed: number, folded = false) => ({ seat, committed, folded });

describe("buildPots", () => {
  it("makes one pot when everyone put in the same", () => {
    expect(buildPots([c(0, 100), c(1, 100), c(2, 100)])).toEqual([{ amount: 300, eligible: [0, 1, 2] }]);
  });

  it("keeps folded chips in the pot but not in the running", () => {
    expect(buildPots([c(0, 100), c(1, 100), c(2, 40, true)])).toEqual([{ amount: 240, eligible: [0, 1] }]);
  });

  it("makes a side pot when one player is all-in for less", () => {
    expect(buildPots([c(0, 50), c(1, 200), c(2, 200)])).toEqual([
      { amount: 150, eligible: [0, 1, 2] },
      { amount: 300, eligible: [1, 2] },
    ]);
  });

  it("makes a side pot for each all-in level with three all-ins", () => {
    expect(buildPots([c(0, 30), c(1, 80), c(2, 150), c(3, 400)])).toEqual([
      { amount: 120, eligible: [0, 1, 2, 3] }, // 30 x 4
      { amount: 150, eligible: [1, 2, 3] }, // 50 x 3
      { amount: 140, eligible: [2, 3] }, // 70 x 2
      { amount: 250, eligible: [3] }, // uncalled part, back to its owner
    ]);
  });

  it("puts a folder's chips into the pots they reached", () => {
    // Seat 3 called 100 then folded: 30 goes to the main pot, 70 to the side pot.
    expect(buildPots([c(0, 30), c(1, 200), c(2, 200), c(3, 100, true)])).toEqual([
      { amount: 120, eligible: [0, 1, 2] },
      { amount: 410, eligible: [1, 2] },
    ]);
  });

  it("merges equal all-in amounts into one level", () => {
    expect(buildPots([c(0, 60), c(1, 60), c(2, 200), c(3, 200)])).toEqual([
      { amount: 240, eligible: [0, 1, 2, 3] },
      { amount: 280, eligible: [2, 3] },
    ]);
  });

  it("never loses or invents chips", () => {
    const contribs = [c(0, 17), c(1, 233), c(2, 99, true), c(3, 233), c(4, 5, true)];
    const total = buildPots(contribs).reduce((s, p) => s + p.amount, 0);
    expect(total).toBe(17 + 233 + 99 + 233 + 5);
  });
});

describe("awardPots", () => {
  const order = [1, 2, 3, 0]; // clockwise from the left of the button (seat 0)

  it("gives a pot to the single best hand", () => {
    const [a] = awardPots([{ amount: 300, eligible: [0, 1, 2] }], new Map([[0, 5], [1, 9], [2, 3]]), order);
    expect(a!.winners).toEqual([1]);
    expect(a!.shares).toEqual([300]);
  });

  it("splits a tied pot evenly", () => {
    const [a] = awardPots([{ amount: 300, eligible: [0, 1, 2] }], new Map([[0, 9], [1, 9], [2, 3]]), order);
    expect(a!.winners).toEqual([1, 0]);
    expect(a!.shares).toEqual([150, 150]);
  });

  it("gives odd chips to the first winners left of the button", () => {
    const [a] = awardPots([{ amount: 305, eligible: [0, 2, 3] }], new Map([[0, 9], [2, 9], [3, 9]]), order);
    expect(a!.winners).toEqual([2, 3, 0]);
    expect(a!.shares).toEqual([102, 102, 101]);
    const [b] = awardPots([{ amount: 101, eligible: [0, 3] }], new Map([[0, 9], [3, 9]]), order);
    expect(b!.winners).toEqual([3, 0]);
    expect(b!.shares).toEqual([51, 50]);
  });

  it("lets a short all-in win the main pot while the side pot goes elsewhere", () => {
    const pots = buildPots([c(0, 50), c(1, 200), c(2, 200)]);
    const awards = awardPots(pots, new Map([[0, 99], [1, 50], [2, 10]]), order);
    expect(awards.map((a) => [a.winners, a.shares])).toEqual([
      [[0], [150]],
      [[1], [300]],
    ]);
  });

  it("splits only the pots where hands tie", () => {
    const pots = buildPots([c(0, 30), c(1, 80), c(2, 150), c(3, 150)]);
    // Seats 0 and 2 tie for best; seat 0 only reaches the main pot.
    const awards = awardPots(pots, new Map([[0, 9], [1, 1], [2, 9], [3, 5]]), order);
    expect(awards.map((a) => [a.winners, a.shares])).toEqual([
      [[2, 0], [60, 60]],
      [[2], [150]],
      [[2], [140]],
    ]);
  });
});
