// Your chips, stats and settings, kept in this browser. Every read and write
// is wrapped in try/catch: private browsing or blocked storage just means
// nothing is remembered, and the game still works.

export const START_STACK = 1000;

export interface BestHand {
  score: number;
  name: string;
  cards: string[];
}

export interface Stats {
  handsPlayed: number;
  handsWon: number;
  biggestPot: number;
  bestHand: BestHand | null;
  rebuys: number;
}

export interface Saved {
  chips: number;
  stats: Stats;
  muted: boolean;
  players: number;
}

const KEY = "pocket-pixels:v1";

export function emptyStats(): Stats {
  return { handsPlayed: 0, handsWon: 0, biggestPot: 0, bestHand: null, rebuys: 0 };
}

export function defaults(): Saved {
  return { chips: START_STACK, stats: emptyStats(), muted: false, players: 5 };
}

const count = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;

/** Read saved data, falling back to defaults for anything missing or broken. */
export function load(storage: Pick<Storage, "getItem"> | null = safeStorage()): Saved {
  const d = defaults();
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return d;
    const v = JSON.parse(raw) as Partial<Omit<Saved, "stats">> & { stats?: Partial<Stats> };
    const s: Partial<Stats> = v.stats ?? {};
    const best = s.bestHand;
    return {
      chips: count(v.chips, d.chips),
      muted: v.muted === true,
      players: [2, 3, 4, 5].includes(v.players as number) ? (v.players as number) : d.players,
      stats: {
        handsPlayed: count(s.handsPlayed, 0),
        handsWon: count(s.handsWon, 0),
        biggestPot: count(s.biggestPot, 0),
        rebuys: count(s.rebuys, 0),
        bestHand:
          best && typeof best.name === "string" && typeof best.score === "number" && Array.isArray(best.cards)
            ? { score: best.score, name: best.name, cards: best.cards.filter((c: unknown): c is string => typeof c === "string" && /^([2-9TJQKA]|10)[shdc]$/.test(c)).slice(0, 5) }
            : null,
      },
    };
  } catch {
    return d;
  }
}

export function save(data: Saved, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked: keep playing without saving.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
