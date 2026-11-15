// Moving chips around the table.

import { sleep } from "./timing";

export function center(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export interface SlideOptions {
  duration: number;
  fade?: "in" | "out";
  shrink?: boolean;
}

/**
 * Animate `el` from the center of `from` to the center of `to`. Offsets are
 * relative to where `el` sits, so `slide(el, seat, el)` brings it in from a
 * seat and `slide(el, el, pot)` sends it to the pot.
 *
 * Resolves when the animation ends, or shortly after its duration at the
 * latest, so a paused page (an app switch, a hidden tab) never stalls a hand.
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
    { duration: opts.duration, easing: "ease-in-out", fill: "forwards" },
  );
  return Promise.race([anim.finished.then(() => undefined, () => undefined), sleep(opts.duration + 200)]);
}
