// Hand ranking. Two evaluators share one score encoding:
//  - evaluateHand: tries every 5-card combination and returns the winning five cards
//    plus a readable name. Used at showdown.
//  - score7: fast, allocation-light scoring of 5 to 7 cards. Used by the bots'
//    simulations. Tests check both always agree.
//
// Score encoding: category * 16^5 + five tiebreak ranks (one hex digit each, high first).
// A higher score is a better hand; equal scores are an exact tie.

import { type Card, type Rank, rankName } from "./cards";

export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const THREE_OF_A_KIND = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const FOUR_OF_A_KIND = 7;
export const STRAIGHT_FLUSH = 8;

export const CATEGORY_NAMES = [
  "High card", "Pair", "Two pair", "Three of a kind", "Straight",
  "Flush", "Full house", "Four of a kind", "Straight flush",
] as const;

export interface HandRank {
  category: number;
  score: number;
  /** Tiebreak ranks in order of importance. */
  ranks: Rank[];
  /** The five cards that make the hand, in display order. */
  cards: Card[];
  /** Readable name such as "Flush, king high". */
  name: string;
}

function encode(category: number, ranks: readonly number[]): number {
  let s = category;
  for (let i = 0; i < 5; i++) s = s * 16 + (ranks[i] ?? 0);
  return s;
}

export function categoryOf(score: number): number {
  return Math.floor(score / 16 ** 5);
}

/** Evaluate exactly five cards. */
export function evaluate5(five: readonly Card[]): HandRank {
  if (five.length !== 5) throw new Error("evaluate5 needs exactly 5 cards");
  const sorted = [...five].sort((a, b) => b.rank - a.rank);
  const first = sorted[0]!;
  const flush = sorted.every((c) => c.suit === first.suit);

  // Group by rank: bigger groups first, then higher rank.
  const byRank = new Map<Rank, Card[]>();
  for (const c of sorted) {
    const g = byRank.get(c.rank);
    if (g) g.push(c);
    else byRank.set(c.rank, [c]);
  }
  const groups = [...byRank.values()].sort((a, b) => b.length - a.length || b[0]!.rank - a[0]!.rank);

  let straightHigh = 0;
  let straightCards = sorted;
  if (groups.length === 5) {
    if (first.rank - sorted[4]!.rank === 4) straightHigh = first.rank;
    else if (first.rank === 14 && sorted[1]!.rank === 5) {
      // The wheel: A-2-3-4-5, the ace plays low.
      straightHigh = 5;
      straightCards = [...sorted.slice(1), first];
    }
  }

  const sizes = groups.map((g) => g.length);
  let category: number;
  if (straightHigh && flush) category = STRAIGHT_FLUSH;
  else if (sizes[0] === 4) category = FOUR_OF_A_KIND;
  else if (sizes[0] === 3 && sizes[1] === 2) category = FULL_HOUSE;
  else if (flush) category = FLUSH;
  else if (straightHigh) category = STRAIGHT;
  else if (sizes[0] === 3) category = THREE_OF_A_KIND;
  else if (sizes[0] === 2 && sizes[1] === 2) category = TWO_PAIR;
  else if (sizes[0] === 2) category = PAIR;
  else category = HIGH_CARD;

  const isStraight = category === STRAIGHT || category === STRAIGHT_FLUSH;
  const ranks: Rank[] = isStraight ? [straightHigh as Rank] : groups.map((g) => g[0]!.rank);
  const cards = isStraight ? straightCards : groups.flat();
  return { category, score: encode(category, ranks), ranks, cards, name: handName(category, ranks) };
}

/** Best five-card hand from 5 to 7 cards. */
export function evaluateHand(cards: readonly Card[]): HandRank {
  const n = cards.length;
  if (n < 5 || n > 7) throw new Error("evaluateHand needs 5 to 7 cards");
  let best: HandRank | null = null;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const h = evaluate5([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (!best || h.score > best.score) best = h;
          }
  return best!;
}

const SUIT_INDEX = { s: 0, h: 1, d: 2, c: 3 } as const;

/** Highest straight in a rank bitmask (bit r set for rank r), or 0. */
function straightHighFromMask(mask: number): number {
  // Let the ace also count as a 1 for the wheel.
  const m = mask & (1 << 14) ? mask | 2 : mask;
  for (let high = 14; high >= 5; high--) {
    const need = 0b11111 << (high - 4);
    if ((m & need) === need) return high;
  }
  return 0;
}

/** Top `count` ranks from a bitmask, skipping any in `exclude`. */
function topRanks(mask: number, count: number, out: number[], exclude = 0): void {
  for (let r = 14; r >= 2 && count > 0; r--) {
    if (mask & (1 << r) && !(exclude & (1 << r))) {
      out.push(r);
      count--;
    }
  }
}

/** Fast score for 5 to 7 cards (same encoding as evaluateHand). */
export function score7(cards: readonly Card[]): number {
  const counts = new Array<number>(15).fill(0);
  const suitCounts = [0, 0, 0, 0];
  const suitMasks = [0, 0, 0, 0];
  let rankMask = 0;
  for (const c of cards) {
    counts[c.rank]!++;
    const s = SUIT_INDEX[c.suit];
    suitCounts[s]!++;
    suitMasks[s]! |= 1 << c.rank;
    rankMask |= 1 << c.rank;
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCounts[s]! >= 5) flushSuit = s;

  if (flushSuit >= 0) {
    const sf = straightHighFromMask(suitMasks[flushSuit]!);
    if (sf) return encode(STRAIGHT_FLUSH, [sf]);
  }

  let quad = 0;
  let trip = 0;
  let trip2 = 0;
  let pair1 = 0;
  let pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const n = counts[r]!;
    if (n === 4) quad = r;
    else if (n === 3) {
      if (!trip) trip = r;
      else if (!trip2) trip2 = r;
    } else if (n === 2) {
      if (!pair1) pair1 = r;
      else if (!pair2) pair2 = r;
    }
  }

  const out: number[] = [];
  if (quad) {
    topRanks(rankMask, 1, out, 1 << quad);
    return encode(FOUR_OF_A_KIND, [quad, ...out]);
  }
  if (trip) {
    const fillPair = Math.max(trip2, pair1);
    if (fillPair) return encode(FULL_HOUSE, [trip, fillPair]);
  }
  if (flushSuit >= 0) {
    topRanks(suitMasks[flushSuit]!, 5, out);
    return encode(FLUSH, out);
  }
  const st = straightHighFromMask(rankMask);
  if (st) return encode(STRAIGHT, [st]);
  if (trip) {
    topRanks(rankMask, 2, out, 1 << trip);
    return encode(THREE_OF_A_KIND, [trip, ...out]);
  }
  if (pair1 && pair2) {
    topRanks(rankMask, 1, out, (1 << pair1) | (1 << pair2));
    return encode(TWO_PAIR, [pair1, pair2, ...out]);
  }
  if (pair1) {
    topRanks(rankMask, 3, out, 1 << pair1);
    return encode(PAIR, [pair1, ...out]);
  }
  topRanks(rankMask, 5, out);
  return encode(HIGH_CARD, out);
}

export function handName(category: number, ranks: readonly Rank[]): string {
  const [a, b] = ranks;
  const one = (r: Rank | undefined) => rankName(r ?? 2);
  const many = (r: Rank | undefined) => rankName(r ?? 2, true);
  switch (category) {
    case HIGH_CARD: return `High card, ${one(a)}`;
    case PAIR: return `Pair of ${many(a)}`;
    case TWO_PAIR: return `Two pair, ${many(a)} and ${many(b)}`;
    case THREE_OF_A_KIND: return `Three of a kind, ${many(a)}`;
    case STRAIGHT: return `Straight, ${one(a)} high`;
    case FLUSH: return `Flush, ${one(a)} high`;
    case FULL_HOUSE: return `Full house, ${many(a)} full of ${many(b)}`;
    case FOUR_OF_A_KIND: return `Four of a kind, ${many(a)}`;
    case STRAIGHT_FLUSH: return a === 14 ? "Royal flush" : `Straight flush, ${one(a)} high`;
    default: return "Unknown hand";
  }
}

/**
 * Name of a winning hand, adding the deciding kicker when it beat a hand of the
 * same kind on a kicker (for example "Pair of kings, ace kicker").
 */
export function describeWin(winner: HandRank, beaten: readonly HandRank[]): string {
  let kicker: Rank | null = null;
  const lead = leadingRanks(winner.category);
  for (const other of beaten) {
    if (other.category !== winner.category || other.score >= winner.score) continue;
    const sameLead = winner.ranks.slice(0, lead).every((r, i) => other.ranks[i] === r);
    if (!sameLead) continue;
    for (let i = lead; i < winner.ranks.length; i++) {
      if (winner.ranks[i] !== other.ranks[i]) {
        const r = winner.ranks[i]!;
        if (kicker === null || r > kicker) kicker = r;
        break;
      }
    }
  }
  return kicker === null ? winner.name : `${winner.name}, ${rankName(kicker)} kicker`;
}

/** How many tiebreak ranks the hand name already mentions. */
function leadingRanks(category: number): number {
  switch (category) {
    case PAIR: case THREE_OF_A_KIND: case FOUR_OF_A_KIND: return 1;
    case TWO_PAIR: return 2;
    case HIGH_CARD: case FLUSH: return 1;
    default: return 5;
  }
}
