// The table drawn as pixel art: nested rounded rectangles rasterized into
// rows of big pixels, so the corners step like an 8-bit sprite.

const PX = 3; // screen pixels per art pixel

interface Layer {
  inset: number;
  color: string;
}

const LAYERS: Layer[] = [
  { inset: 0, color: "#140b05" }, // outline
  { inset: 1, color: "#6b4226" }, // rail highlight
  { inset: 2, color: "#4a2c1a" }, // rail
  { inset: 4, color: "#140b05" }, // inner outline
  { inset: 5, color: "#145238" }, // felt edge
  { inset: 7, color: "#18603f" }, // felt
  { inset: 10, color: "#1b6e4b" }, // felt center
];

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
