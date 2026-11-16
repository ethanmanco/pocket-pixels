import { describe, expect, it } from "vitest";
import { AVATARS, AVATAR_CHOICES } from "../src/ui/avatars";

describe("pixel art", () => {
  it("every avatar is a 14 x 14 grid using only its palette", () => {
    for (const [name, art] of Object.entries(AVATARS).filter(([k]) => k !== "open")) {
      expect(art.rows, name).toHaveLength(14);
      art.rows.forEach((row, y) => {
        expect(row.length, `${name} row ${y}`).toBe(14);
        for (const ch of row) if (ch !== ".") expect(art.palette[ch], `${name} '${ch}'`).toBeDefined();
      });
    }
  });

  it("offers dozens of avatars to pick from, many of them space themed", () => {
    expect(AVATAR_CHOICES.length).toBeGreaterThanOrEqual(120);
    expect(AVATAR_CHOICES.filter((a) => a.group === "monster").length).toBeGreaterThanOrEqual(40);
    expect(AVATAR_CHOICES.filter((a) => a.space).length).toBeGreaterThanOrEqual(30);
    expect(new Set(AVATAR_CHOICES.map((a) => a.key)).size).toBe(AVATAR_CHOICES.length);
  });
});
