import { describe, expect, it } from "vitest";
import { defaults, load, save } from "../src/ui/storage";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("saved data", () => {
  it("round-trips chips, stats and settings", () => {
    const s = memory();
    const data = defaults();
    data.chips = 2345;
    data.muted = true;
    data.players = 3;
    data.stats = { handsPlayed: 12, handsWon: 4, biggestPot: 880, rebuys: 1, bestHand: { score: 99, name: "Flush, king high", cards: ["Kh", "Jh", "9h", "6h", "2h"] } };
    save(data, s);
    expect(load(s)).toEqual(data);
  });

  it("falls back to defaults when nothing is saved", () => {
    expect(load(memory())).toEqual(defaults());
    expect(load(null)).toEqual(defaults());
  });

  it("survives broken or tampered data", () => {
    const s = memory();
    s.setItem("pocket-pixels:v1", "{not json");
    expect(load(s)).toEqual(defaults());
    s.setItem("pocket-pixels:v1", JSON.stringify({ chips: -50, players: 9, muted: "yes", stats: { handsPlayed: "lots", bestHand: { name: 3 } } }));
    expect(load(s)).toEqual(defaults());
  });

  it("does not throw when storage itself throws", () => {
    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("full"); },
    };
    expect(load(broken)).toEqual(defaults());
    expect(() => save(defaults(), broken)).not.toThrow();
  });
});
