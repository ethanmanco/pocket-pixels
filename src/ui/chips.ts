// Pixel-art chips drawn in code as tiny SVGs (one rect per pixel row run),
// scaled up with crisp edges so they stay blocky.

export interface Denomination {
  value: number;
  face: string;
  shade: string;
  stripe: string;
}

export const DENOMINATIONS: readonly Denomination[] = [
  { value: 1000, face: "#f0a202", shade: "#a86f00", stripe: "#fff4c2" },
  { value: 500, face: "#8e44d6", shade: "#5a2690", stripe: "#f1e4ff" },
  { value: 100, face: "#2b2d42", shade: "#14151f", stripe: "#f4f1de" },
  { value: 25, face: "#2a9d4b", shade: "#18652f", stripe: "#f4f1de" },
  { value: 5, face: "#d62839", shade: "#8c1622", stripe: "#f4f1de" },
  { value: 1, face: "#e9e4d4", shade: "#a8a294", stripe: "#1d5fd1" },
];

/** Fewest chips that make `amount`, biggest first. */
export function chipBreakdown(amount: number): Denomination[] {
  const out: Denomination[] = [];
  let left = Math.max(0, Math.floor(amount));
  for (const d of DENOMINATIONS) {
    while (left >= d.value) {
      out.push(d);
      left -= d.value;
    }
  }
  return out;
}

/**
 * Columns of chips for a pile: one column per denomination (split when tall),
 * at most `maxColumns` columns of `maxHeight` chips. The label always shows
 * the true amount, so trimming tall piles only changes the picture.
 */
export function pileColumns(amount: number, maxColumns: number, maxHeight: number): Denomination[][] {
  const chips = chipBreakdown(amount);
  const cols: Denomination[][] = [];
  for (const d of DENOMINATIONS) {
    const same = chips.filter((c) => c === d);
    for (let i = 0; i < same.length; i += maxHeight) cols.push(same.slice(i, i + maxHeight));
  }
  // Keep the most valuable columns when there are too many.
  return cols.slice(0, maxColumns);
}

/** One mixed stack, biggest chips at the bottom, for a bet in front of a player. */
export function stackColumn(amount: number, maxHeight: number): Denomination[] {
  const chips = chipBreakdown(amount);
  if (chips.length <= maxHeight) return chips;
  return chips.slice(0, maxHeight);
}

const W = 10; // chip width in pixels
const SIDE = 2; // each chip's edge is 2 pixels tall
const FACE = 3; // the top chip's face

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
}

function columnRects(col: Denomination[], x: number, bottom: number): string {
  let out = "";
  // Draw from the bottom chip up; each chip shows its striped edge.
  col.forEach((d, i) => {
    const y = bottom - (i + 1) * SIDE;
    out += rect(x, y, W, 1, d.face);
    out += rect(x + 1, y, 1, 1, d.stripe) + rect(x + 4, y, 2, 1, d.stripe) + rect(x + 8, y, 1, 1, d.stripe);
    out += rect(x, y + 1, W, 1, d.shade);
  });
  // The top chip's face: an oval with a lighter inlay.
  const top = col[col.length - 1];
  if (top) {
    const y = bottom - col.length * SIDE - FACE;
    out += rect(x + 1, y, W - 2, 1, top.face);
    out += rect(x, y + 1, W, 2, top.face);
    out += rect(x + 3, y + 1, 4, 1, top.stripe);
    out += rect(x + 1, y + 2, 1, 1, top.stripe) + rect(x + 8, y + 2, 1, 1, top.stripe);
  }
  return out;
}

/** SVG markup for columns of chips side by side, bottoms aligned. */
export function chipsSVG(cols: Denomination[][], scale: number): string {
  if (!cols.length) return "";
  const tallest = Math.max(...cols.map((c) => c.length));
  const h = tallest * SIDE + FACE;
  const w = cols.length * (W + 1) - 1;
  const body = cols.map((c, i) => columnRects(c, i * (W + 1), h)).join("");
  return (
    `<svg class="chips-svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" ` +
    `shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`
  );
}
