// Main pot and side pots, built from how much each player put in this hand.

export interface Contribution {
  seat: number;
  committed: number;
  /** Folded players' chips stay in the pot, but they cannot win it. */
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Seats that can win this pot. */
  eligible: number[];
}

/**
 * Layer the chips at each all-in level. Every layer is a pot that only the
 * players who covered that level can win. The first pot is the main pot.
 */
export function buildPots(contribs: readonly Contribution[]): Pot[] {
  const levels = [
    ...new Set(contribs.filter((c) => !c.folded && c.committed > 0).map((c) => c.committed)),
  ].sort((a, b) => a - b);

  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contribs) amount += Math.min(c.committed, level) - Math.min(c.committed, prev);
    const eligible = contribs.filter((c) => !c.folded && c.committed >= level).map((c) => c.seat);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }

  // Folded chips above every live player's level (should not happen once
  // uncalled bets are returned) go into the last pot so nothing is lost.
  const total = contribs.reduce((sum, c) => sum + c.committed, 0);
  const placed = pots.reduce((sum, p) => sum + p.amount, 0);
  const last = pots[pots.length - 1];
  if (total > placed && last) last.amount += total - placed;
  return pots;
}

export interface PotAward {
  amount: number;
  eligible: number[];
  winners: number[];
  /** Chips each winner gets, in the same order as `winners`. */
  shares: number[];
}

/**
 * Split each pot between the best hands among its eligible players.
 * `scores` holds a hand score per seat (higher wins). Odd chips go one at a
 * time to the winners closest to the left of the button, as in a cardroom.
 */
export function awardPots(
  pots: readonly Pot[],
  scores: ReadonlyMap<number, number>,
  oddChipOrder: readonly number[],
): PotAward[] {
  return pots.map((pot) => {
    let best = -Infinity;
    for (const s of pot.eligible) best = Math.max(best, scores.get(s) ?? -Infinity);
    const winners = oddChipOrder.filter((s) => pot.eligible.includes(s) && scores.get(s) === best);
    const base = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - base * winners.length;
    const shares = winners.map(() => base + (odd-- > 0 ? 1 : 0));
    return { amount: pot.amount, eligible: [...pot.eligible], winners, shares };
  });
}
