// Tiny pixel-art helper: turn a text grid into a crisp SVG.
// Each character is a palette key; "." is transparent.

export type Palette = Record<string, string>;

export function pixelSVG(rows: readonly string[], palette: Palette, scale: number, className = ""): string {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  let body = "";
  rows.forEach((row, y) => {
    // Merge runs of the same color into one rect to keep the markup small.
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      let run = 1;
      while (row[x + run] === ch) run++;
      const fill = palette[ch];
      if (ch !== "." && fill) body += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${fill}"/>`;
      x += run;
    }
  });
  return (
    `<svg class="${className}" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" ` +
    `shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`
  );
}
