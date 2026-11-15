// The table drawn as pixel art: nested rounded rectangles rasterized into
// rows of big pixels, so the corners step like an 8-bit sprite. Space theme:
// a deep-blue felt printed with faint stars, inside a station rail with small
// running lights.

import { Rng } from "../engine/rng";

const PX = 3; // screen pixels per art pixel

interface Layer {
  inset: number;
  color: string;
}

const LAYERS: Layer[] = [
  { inset: 0, color: "#04030c" }, // outline
  { inset: 1, color: "#8a8fd8" }, // rail highlight
  { inset: 2, color: "#3d3a7a" }, // rail
  { inset: 4, color: "#04030c" }, // inner outline
  { inset: 5, color: "#0e1638" }, // felt edge
  { inset: 7, color: "#131e4a" }, // felt
  { inset: 10, color: "#17275c" }, // felt center
];

const FELT_STARS = ["#2a3a78", "#33478c", "#4a5fa8"];
const LIGHTS = ["#36e2ff", "#ffd166", "#ff6b9d"];

/** Left/right inset of a rounded rectangle at row y. */
function rowInset(y: number, h: number, r: number): number {
  const dy = y < r ? r - y - 0.5 : y >= h - r ? y - (h - r) + 0.5 : -1;
  if (dy < 0) return 0;
  return Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
}

export function tableSVG(width: number, height: number): string {
  const w = Math.floor(width / PX);
  const h = Math.floor(height / PX);
  const radius = Math.max(6, Math.round(Math.min(w, h) * 0.16));
  let body = "";
  for (const layer of LAYERS) {
    const lw = w - layer.inset * 2;
    const lh = h - layer.inset * 2;
    const r = Math.max(2, radius - layer.inset);
    if (lw <= 0 || lh <= 0) continue;
    let y = 0;
    while (y < lh) {
      // Merge rows with the same inset into one rect.
      const inset = rowInset(y, lh, r);
      let run = 1;
      while (y + run < lh && rowInset(y + run, lh, r) === inset) run++;
      body += `<rect x="${layer.inset + inset}" y="${layer.inset + y}" width="${lw - inset * 2}" height="${run}" fill="${layer.color}"/>`;
      y += run;
    }
  }

  // Faint stars printed on the felt (same pattern every time).
  const rng = new Rng(7);
  const felt = 8; // keep clear of the felt's edge
  const fh = h - felt * 2;
  const fr = Math.max(2, radius - felt);
  for (let i = 0; i < Math.floor(((w - felt * 2) * fh) / 70); i++) {
    const x = felt + rng.int(w - felt * 2);
    const y = felt + rng.int(fh);
    const inset = rowInset(y - felt, fh, fr);
    if (x < felt + inset || x >= w - felt - inset) continue;
    body += `<rect x="${x}" y="${y}" width="1" height="1" fill="${FELT_STARS[rng.int(FELT_STARS.length)]}"/>`;
  }

  // Running lights along the straight parts of the rail.
  const step = 9;
  let n = 0;
  for (let x = radius + 2; x < w - radius - 2; x += step) {
    const c = LIGHTS[n++ % LIGHTS.length];
    body += `<rect x="${x}" y="2" width="1" height="1" fill="${c}"/><rect x="${x}" y="${h - 3}" width="1" height="1" fill="${c}"/>`;
  }
  for (let y = radius + 2; y < h - radius - 2; y += step) {
    const c = LIGHTS[n++ % LIGHTS.length];
    body += `<rect x="2" y="${y}" width="1" height="1" fill="${c}"/><rect x="${w - 3}" y="${y}" width="1" height="1" fill="${c}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * PX}" height="${h * PX}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>`;
}

/** Keep the element's background painted as a pixel table at its current size. */
export function paintTable(el: HTMLElement): void {
  let last = "";
  const paint = () => {
    const { width, height } = el.getBoundingClientRect();
    const key = `${Math.round(width)}x${Math.round(height)}`;
    if (key === last || width < 10 || height < 10) return;
    last = key;
    const svg = tableSVG(width, height);
    el.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  };
  paint();
  new ResizeObserver(paint).observe(el);
}
