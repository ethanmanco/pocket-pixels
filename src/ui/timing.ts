// Pauses and motion settings shared by the table.
// `?fast` in the URL (dev only) skips every pause and animation, for automated checks.

const FAST = import.meta.env.DEV && new URLSearchParams(location.search).has("fast");

export function sleep(ms: number): Promise<void> {
  if (FAST) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

export function reducedMotion(): boolean {
  return FAST || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** `?seed=123` in the URL (dev only) makes the deal and the bots repeatable, for demos. */
export function devSeed(): number | null {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(location.search).get("seed");
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
}
