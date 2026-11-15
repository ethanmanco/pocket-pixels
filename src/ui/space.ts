// The space backdrop: a pixel starfield with a dithered nebula, a ringed
// planet and a small moon, drawn once (per screen size) into a low-resolution
// canvas and scaled up with crisp pixels. A handful of stars twinkle slowly
// with CSS; nothing flashes, and reduced motion keeps them still.

import { Rng } from "../engine/rng";

const PX = 3; // screen pixels per art pixel

// 4 x 4 ordered dither: smooth gradients from a few flat colors.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const dither = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)]!;

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

const SKY = ["#05050f", "#080a1c", "#0c0d27"].map(hex);
const NEBULA = ["#1b1240", "#2a1652", "#102d4a"].map(hex);
const STARS = ["#ffffff", "#cfe3ff", "#ffe9b0", "#b9a8ff"].map(hex);
const PLANET = ["#3b2d7a", "#5b46b0", "#8b74e6", "#c4b3ff"].map(hex); // dark to light
const RING = ["#d9a441", "#f3d27a"].map(hex);
const MOON = ["#5e6a80", "#9aa7bd", "#d7deea"].map(hex);

export function paintSpace(canvas: HTMLCanvasElement, twinkleLayer: HTMLElement): void {
  let last = "";
  const draw = () => {
    const w = Math.ceil(window.innerWidth / PX);
    const h = Math.ceil(window.innerHeight / PX);
    const key = `${w}x${h}`;
    if (key === last) return;
    last = key;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const put = (x: number, y: number, c: [number, number, number]) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    };
    const rng = new Rng(20261115);

    // Sky: a dithered vertical gradient.
    for (let y = 0; y < h; y++) {
      const t = (y / h) * (SKY.length - 1);
      for (let x = 0; x < w; x++) {
        const band = Math.min(SKY.length - 1, Math.floor(t + dither(x, y)));
        put(x, y, SKY[band]!);
      }
    }

    // Nebula: two soft clouds, dithered out at the edges.
    const clouds = [
      { cx: w * 0.2, cy: h * 0.3, r: Math.max(w, h) * 0.45, c: 0 },
      { cx: w * 0.85, cy: h * 0.8, r: Math.max(w, h) * 0.4, c: 2 },
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (const cl of clouds) {
          const dist = Math.hypot(x - cl.cx, (y - cl.cy) * 1.4) / cl.r;
          const wave = 0.5 + 0.25 * Math.sin(x * 0.09 + y * 0.05) + 0.25 * Math.sin(y * 0.11 - x * 0.03);
          const v = (1 - dist) * wave;
          if (v > 0.12 + dither(x, y) * 0.5) put(x, y, NEBULA[v > 0.45 ? 1 : cl.c]!);
        }
      }
    }

    // Stars: mostly single pixels, a few bright crosses.
    const count = Math.floor((w * h) / 90);
    for (let i = 0; i < count; i++) {
      const x = rng.int(w);
      const y = rng.int(h);
      const c = STARS[rng.int(STARS.length)]!;
      const dim = rng.next() < 0.6;
      put(x, y, dim ? [c[0] * 0.55, c[1] * 0.55, c[2] * 0.6] : c);
      if (!dim && rng.next() < 0.12) {
        put(x - 1, y, [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5]);
        put(x + 1, y, [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5]);
        put(x, y - 1, [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5]);
        put(x, y + 1, [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5]);
      }
    }

    // Planet and moon only where they show: on narrow phones the table covers them.
    const wide = window.innerWidth >= 700;
    // Ringed planet, lit from the upper left.
    const pr = Math.max(14, Math.round(Math.min(w, h) * 0.16));
    const px = Math.round(w * 0.86);
    const py = Math.round(h * 0.16);
    const ringBack: [number, number][] = [];
    const ringFront: [number, number][] = [];
    for (let a = 0; a < Math.PI * 2; a += 0.004) {
      for (const k of [1.55, 1.65, 1.75]) {
        const rx = Math.round(px + Math.cos(a) * pr * k);
        const ry = Math.round(py + Math.sin(a) * pr * k * 0.28);
        (Math.sin(a) < 0 ? ringBack : ringFront).push([rx, ry]);
      }
    }
    if (wide) for (const [x, y] of ringBack) put(x, y, RING[0]!);
    for (let y = -pr; y <= pr && wide; y++) {
      for (let x = -pr; x <= pr; x++) {
        if (x * x + y * y > pr * pr) continue;
        // Light from the upper left, dithered into four shades.
        const light = (-(x + y) / (pr * 1.6) + 0.55) * (PLANET.length - 1);
        const band = Math.max(0, Math.min(PLANET.length - 1, Math.floor(light + dither(x + px, y + py))));
        // Faint stripes, like bands of cloud.
        const stripe = Math.sin((y / pr) * 9) > 0.75 ? 1 : 0;
        put(px + x, py + y, PLANET[Math.min(PLANET.length - 1, band + stripe)]!);
      }
    }
    if (wide) for (const [x, y] of ringFront) put(x, y, RING[1]!);

    // A small moon.
    const mr = Math.max(5, Math.round(pr * 0.32));
    const mx = Math.round(w * 0.1);
    const my = Math.round(h * 0.88);
    for (let y = -mr; y <= mr && wide; y++) {
      for (let x = -mr; x <= mr; x++) {
        if (x * x + y * y > mr * mr) continue;
        const light = (-(x + y) / (mr * 1.6) + 0.5) * (MOON.length - 1);
        const band = Math.max(0, Math.min(MOON.length - 1, Math.floor(light + dither(x, y))));
        put(mx + x, my + y, MOON[band]!);
      }
    }
    ctx.putImageData(img, 0, 0);

    // A few stars that twinkle slowly (CSS, so reduced motion can stop them).
    const tw: HTMLElement[] = [];
    for (let i = 0; i < 14; i++) {
      const s = document.createElement("i");
      s.style.left = `${(rng.next() * 100).toFixed(2)}%`;
      s.style.top = `${(rng.next() * 100).toFixed(2)}%`;
      s.style.animationDelay = `${(rng.next() * 6).toFixed(2)}s`;
      s.style.animationDuration = `${(4 + rng.next() * 4).toFixed(2)}s`;
      tw.push(s);
    }
    twinkleLayer.replaceChildren(...tw);
  };
  draw();
  window.addEventListener("resize", draw);
}
