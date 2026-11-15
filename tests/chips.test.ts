import { describe, expect, it } from "vitest";
import { chipBreakdown, pileColumns, stackColumn } from "../src/ui/chips";

const values = (ds: { value: number }[]) => ds.map((d) => d.value);
const sum = (ds: { value: number }[]) => ds.reduce((s, d) => s + d.value, 0);

describe("chips", () => {
  it("breaks an amount into the fewest chips", () => {
    expect(values(chipBreakdown(10))).toEqual([5, 5]);
    expect(values(chipBreakdown(135))).toEqual([100, 25, 5, 5]);
    expect(values(chipBreakdown(1613))).toEqual([1000, 500, 100, 5, 5, 1, 1, 1]);
    expect(chipBreakdown(0)).toEqual([]);
  });

  it("always adds back up to the amount", () => {
    for (const n of [1, 7, 12, 99, 240, 999, 4321]) expect(sum(chipBreakdown(n))).toBe(n);
  });

  it("groups a pile into columns by color, capped in size", () => {
    const cols = pileColumns(1240, 5, 8);
    expect(cols.map(values)).toEqual([[1000], [100, 100], [25], [5, 5, 5]]);
    expect(pileColumns(9000, 3, 4).map((c) => c.length)).toEqual([4, 4, 1]);
  });

  it("caps a bet stack's height", () => {
    expect(stackColumn(40, 4)).toHaveLength(4);
    expect(values(stackColumn(130, 6))).toEqual([100, 25, 5]);
  });
});
