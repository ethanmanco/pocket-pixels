// Moving chips and cards around the table.

import { sleep } from "./timing";

export function center(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Wait for an animation, but never longer than its length plus a little (paused pages). */
function settle(anim: Animation, ms: number): Promise<void> {
  return Promise.race([anim.finished.then(() => undefined, () => undefined), sleep(ms + 200)]);
}

export interface SlideOptions {
  duration: number;
  delay?: number;
  fade?: "in" | "out";
  shrink?: boolean;
}

/**
 * Animate `el` from the center of `from` to the center of `to`. Offsets are
 * relative to where `el` sits, so `slide(el, seat, el)` brings it in from a
 * seat and `slide(el, el, pot)` sends it to the pot.
 */
export function slide(el: HTMLElement, from: Element, to: Element, opts: SlideOptions): Promise<void> {
  const a = center(from);
  const b = center(to);
  const here = center(el);
  const base = getComputedStyle(el).transform;
  const keep = base === "none" ? "" : ` ${base}`;
  const start = { x: a.x - here.x, y: a.y - here.y };
  const end = { x: b.x - here.x, y: b.y - here.y };
  const anim = el.animate(
    [
      { transform: `translate(${start.x}px, ${start.y}px)${keep}`, opacity: opts.fade === "in" ? 0 : 1 },
      {
        transform: `translate(${end.x}px, ${end.y}px)${keep}${opts.shrink ? " scale(0.6)" : ""}`,
        opacity: opts.fade === "out" ? 0 : 1,
      },
    ],
    { duration: opts.duration, delay: opts.delay ?? 0, easing: "ease-in-out", fill: "both" },
  );
  return settle(anim, opts.duration + (opts.delay ?? 0));
}

/** Turn a card over: squeeze to nothing and open back up, in a few blocky steps. */
export function flipIn(el: HTMLElement, delay = 0, duration = 260): Promise<void> {
  const anim = el.animate(
    [
      { transform: "scaleX(0)", filter: "brightness(1.6)" },
      { transform: "scaleX(1)", filter: "brightness(1)" },
    ],
    { duration, delay, easing: "steps(5, end)", fill: "both" },
  );
  return settle(anim, duration + delay);
}
