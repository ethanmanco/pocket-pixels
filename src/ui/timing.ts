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
