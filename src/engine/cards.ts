// Cards, decks and the words used to describe them.

export type Suit = "s" | "h" | "d" | "c";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

export const SUITS: readonly Suit[] = ["s", "h", "d", "c"];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const RANK_CHARS: Record<string, Rank> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/** A fresh 52-card deck in a fixed order. */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  return deck;
}

/** Short code such as "As" or "Th". */
export function cardCode(c: Card): string {
  return rankChar(c.rank) + c.suit;
}

export function rankChar(r: Rank): string {
  return r === 10 ? "T" : r === 11 ? "J" : r === 12 ? "Q" : r === 13 ? "K" : r === 14 ? "A" : String(r);
}

/** Rank as printed on a card face: "10" rather than "T". */
export function rankFace(r: Rank): string {
  return r === 10 ? "10" : rankChar(r);
}

/** Parse "As" or "10h" style codes. */
export function parseCard(code: string): Card {
  const s = code.trim();
  const suit = s.slice(-1).toLowerCase() as Suit;
  const r = s.slice(0, -1).toUpperCase();
  const rank = r === "10" ? 10 : RANK_CHARS[r];
  if (!rank || !SUITS.includes(suit)) throw new Error(`Bad card code: ${code}`);
  return { rank, suit };
}

/** Parse a space separated list such as "As Kh 7d". */
export function parseCards(codes: string): Card[] {
  return codes.trim() === "" ? [] : codes.trim().split(/\s+/).map(parseCard);
}

export function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}

const RANK_WORDS: Record<Rank, [string, string]> = {
  2: ["two", "twos"], 3: ["three", "threes"], 4: ["four", "fours"], 5: ["five", "fives"],
  6: ["six", "sixes"], 7: ["seven", "sevens"], 8: ["eight", "eights"], 9: ["nine", "nines"],
  10: ["ten", "tens"], 11: ["jack", "jacks"], 12: ["queen", "queens"], 13: ["king", "kings"],
  14: ["ace", "aces"],
};

export function rankName(r: Rank, plural = false): string {
  return RANK_WORDS[r][plural ? 1 : 0];
}

export const SUIT_NAMES: Record<Suit, string> = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };

/** Screen reader label, e.g. "ace of spades". */
export function cardLabel(c: Card): string {
  return `${rankName(c.rank)} of ${SUIT_NAMES[c.suit]}`;
}
