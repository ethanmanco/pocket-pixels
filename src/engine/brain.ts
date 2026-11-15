// Bot skill levels. The level only changes how a bot decides; the shuffle and
// the deal are the same at every level, and every bot still sees only its own
// PlayerView (its cards, the board, chip counts and the public betting history).
//
//   easy     A beginner: plays too many hands, calls too much, rarely raises,
//            bets small, and now and then just takes the passive option.
//   regular  The original bots: hand strength against random hands, pot odds,
//            position and personality (see bot.ts).
//   hard     A solid player: position-based starting hands, reads opponents'
//            likely hands from their betting, semi-bluffs draws, folds to real
//            pressure. Still makes the odd mistake.
//   insane   Professional-style: everything in hard, plus notes on each opponent
//            (how often they play, raise and bet) that it exploits, balanced
//            bluffing tied to bet size, stack-depth bet sizing, and calling
//            enough that it can't simply be bluffed off its hands.

import { type BotPersonality, STYLES, decide as regularDecide } from "./bot";
import { type Card, makeDeck, sameCard } from "./cards";
import { PAIR, categoryOf, score7 } from "./evaluate";
import type { Action, HandAction, PlayerView } from "./game";
import type { Rng } from "./rng";

export type Level = "easy" | "regular" | "hard" | "insane";
export const LEVELS: Level[] = ["easy", "regular", "hard", "insane"];
export const LEVEL_NAMES: Record<Level, string> = { easy: "Easy", regular: "Regular", hard: "Hard", insane: "Insane" };

export function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Starting hands: the Chen formula, turned into a percentile (0 = best hand,
// 1 = worst) weighted by how many card combinations each hand has.

function chenScore(hi: number, lo: number, suited: boolean): number {
  const points = (r: number) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  if (hi === lo) return Math.max(5, points(hi) * 2);
  let s = points(hi);
  if (suited) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) s += 1;
  return Math.ceil(s);
}

/** Percentile per starting hand class, indexed by hi * 15 + lo, plus 225 when suited. */
const PERCENTILE = new Float64Array(450);
(() => {
  const classes: { idx: number; score: number; combos: number }[] = [];
  for (let hi = 2; hi <= 14; hi++) {
    for (let lo = 2; lo <= hi; lo++) {
      if (hi === lo) classes.push({ idx: hi * 15 + lo, score: chenScore(hi, lo, false), combos: 6 });
      else {
        classes.push({ idx: hi * 15 + lo + 225, score: chenScore(hi, lo, true), combos: 4 });
        classes.push({ idx: hi * 15 + lo, score: chenScore(hi, lo, false), combos: 12 });
      }
    }
  }
  classes.sort((a, b) => b.score - a.score);
  let above = 0;
  let i = 0;
  while (i < classes.length) {
    // Hands with equal scores share a percentile.
    let j = i;
    let combos = 0;
    while (j < classes.length && classes[j]!.score === classes[i]!.score) combos += classes[j++]!.combos;
    for (let k = i; k < j; k++) PERCENTILE[classes[k]!.idx] = (above + combos / 2) / 1326;
    above += combos;
    i = j;
  }
})();

/** 0 for the best starting hands (aces), close to 1 for the worst (seven-two). */
export function preflopPercentile(a: Card, b: Card): number {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  return PERCENTILE[hi * 15 + lo + (a.suit === b.suit && hi !== lo ? 225 : 0)]!;
}

// ---------------------------------------------------------------------------
// Notes on opponents, built only from public betting (insane uses them).

export interface PlayerNotes {
  hands: number;
  /** Put money in voluntarily before the flop. */
  vpip: number;
  /** Raised before the flop. */
  pfr: number;
  /** Bets and raises after the flop. */
  bets: number;
  /** Calls after the flop. */
  calls: number;
  /** Times they faced a bet or raise, and how often they folded to it. */
  facedBet?: number;
  foldedToBet?: number;
}

export type Notes = Record<string, PlayerNotes>;

/** Add one finished hand's public betting to the notes. */
export function updateNotes(notes: Notes, history: readonly HandAction[], dealt: readonly number[]): void {
  for (const seat of dealt) {
    const n = (notes[seat] ??= { hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0, facedBet: 0, foldedToBet: 0 });
    const mine = history.filter((a) => a.seat === seat);
    const pre = mine.filter((a) => a.street === "preflop" && a.kind !== "sb" && a.kind !== "bb");
    n.hands++;
    if (pre.some((a) => a.kind === "call" || a.kind === "raise" || a.kind === "bet")) n.vpip++;
    if (pre.some((a) => a.kind === "raise")) n.pfr++;
    for (const a of mine) {
      if (a.street === "preflop") continue;
      if (a.kind === "bet" || a.kind === "raise") n.bets++;
      else if (a.kind === "call") n.calls++;
    }
  }
  // Folds when facing a bet or raise (not just the blinds).
  let street = "";
  let aggressor = -1;
  for (const a of history) {
    if (a.street !== street) {
      street = a.street;
      aggressor = -1;
    }
    if (aggressor >= 0 && aggressor !== a.seat && dealt.includes(a.seat)) {
      const n = notes[a.seat]!;
      n.facedBet = (n.facedBet ?? 0) + 1;
      if (a.kind === "fold") n.foldedToBet = (n.foldedToBet ?? 0) + 1;
    }
    if (a.kind === "bet" || a.kind === "raise") aggressor = a.seat;
  }
}

function rate(part: number, whole: number, fallback: number, min = 8): number {
  return whole >= min ? part / whole : fallback;
}

// ---------------------------------------------------------------------------
// Reading opponents' likely hands from their betting.

interface Read {
  /** Fraction of starting hands they would play this way (0.05 to 1). */
  range: number;
  /** They bet or raised after the flop, so they likely have something... */
  strongPostflop: boolean;
  /** ...unless they are bluffing, which happens about this often. */
  bluffs: number;
}

function readOpponent(seat: number, view: PlayerView, notes: Notes, insane: boolean): Read {
  const mine = view.history.filter((a) => a.seat === seat);
  const pre = mine.filter((a) => a.street === "preflop" && a.kind !== "sb" && a.kind !== "bb");
  const n = notes[seat];
  const vpip = insane && n ? Math.min(0.9, Math.max(0.12, rate(n.vpip, n.hands, 0.45))) : 0.45;
  const pfr = insane && n ? Math.min(0.5, Math.max(0.04, rate(n.pfr, n.hands, 0.18))) : 0.18;
  let range = 1;
  const raises = pre.filter((a) => a.kind === "raise").length;
  if (raises > 0) range = pfr * Math.pow(0.45, raises - 1);
  else if (pre.some((a) => a.kind === "call")) range = vpip;
  const post = mine.filter((a) => a.street !== "preflop");
  for (const a of post) {
    if (a.kind === "bet" || a.kind === "raise") range *= 0.8;
    else if (a.kind === "call") range *= 0.92;
  }
  const strongPostflop = post.some((a) => a.kind === "bet" || a.kind === "raise");
  // How often their post-flop aggression is a bluff: aggressive players bluff more.
  const aggression = insane && n ? rate(n.bets, n.bets + n.calls, 0.5, 6) : 0.5;
  const bluffs = 0.15 + aggression * 0.3;
  return { range: Math.min(1, Math.max(0.04, range)), strongPostflop, bluffs };
}

/** Has a flush draw or an open-ended straight draw. */
export function hasDraw(hole: readonly Card[], board: readonly Card[]): boolean {
  if (board.length >= 5 || board.length < 3) return false;
  const all = [...hole, ...board];
  for (const suit of ["s", "h", "d", "c"] as const) {
    if (all.filter((c) => c.suit === suit).length === 4 && hole.some((c) => c.suit === suit)) return true;
  }
  let mask = 0;
  for (const c of all) mask |= 1 << c.rank;
  if (mask & (1 << 14)) mask |= 2;
  for (let lo = 1; lo <= 10; lo++) {
    const four = 0b1111 << lo;
    if ((mask & four) === four && hole.some((c) => four & (1 << c.rank))) return true;
  }
  return false;
}

/**
 * Chance of winning against what the opponents are likely holding, given how
 * they have bet: random hands are drawn and kept only if they fit each
 * opponent's read.
 */
export function rangeEquity(view: PlayerView, notes: Notes, insane: boolean, iterations: number, rng: Rng): number {
  const known = [...view.hole, ...view.board];
  const rest = makeDeck().filter((c) => !known.some((k) => sameCard(k, c)));
  const opponents = view.players
    .filter((p) => p.id !== view.seat && (p.status === "active" || p.status === "allin"))
    .map((p) => readOpponent(p.id, view, notes, insane));
  if (!opponents.length) return 1;
  const needBoard = 5 - view.board.length;
  const mine = [...view.hole, ...view.board];
  const theirs: Card[] = [];
  let wins = 0;
  const used = new Set<number>();
  const idx = (c: Card) => c.rank * 4 + "shdc".indexOf(c.suit);

  for (let it = 0; it < iterations; it++) {
    used.clear();
    const hands: Card[][] = [];
    for (const o of opponents) {
      let pick: Card[] = [];
      for (let tries = 0; tries < 40; tries++) {
        const a = rest[rng.int(rest.length)]!;
        const b = rest[rng.int(rest.length)]!;
        if (a === b || used.has(idx(a)) || used.has(idx(b))) continue;
        pick = [a, b];
        const p = preflopPercentile(a, b);
        if (p > o.range && rng.next() > 0.08) continue; // mostly hands in their range
        if (o.strongPostflop && view.board.length >= 3 && rng.next() > o.bluffs) {
          const cat = categoryOf(score7([a, b, ...view.board]));
          if (cat < PAIR && !hasDraw([a, b], view.board)) continue; // they bet with something
        }
        break;
      }
      if (pick.length < 2) {
        // Fall back to any two unused cards.
        const free = rest.filter((c) => !used.has(idx(c)));
        pick = [free[0]!, free[1]!];
      }
      used.add(idx(pick[0]!));
      used.add(idx(pick[1]!));
      hands.push(pick);
    }
    const runout: Card[] = [];
    while (runout.length < needBoard) {
      const c = rest[rng.int(rest.length)]!;
      if (used.has(idx(c))) continue;
      used.add(idx(c));
      runout.push(c);
    }
    mine.length = known.length;
    mine.push(...runout);
    const myScore = score7(mine);
    let best = -1;
    let ties = 0;
    for (const h of hands) {
      theirs.length = 0;
      theirs.push(h[0]!, h[1]!, ...view.board, ...runout);
      const s = score7(theirs);
      if (s > best) {
        best = s;
        ties = 0;
      }
      if (s === best) ties++;
    }
    if (myScore > best) wins += 1;
    else if (myScore === best) wins += 1 / (ties + 1);
  }
  return wins / iterations;
}

// ---------------------------------------------------------------------------
// Deciding.

const round5 = (n: number) => Math.round(n / 5) * 5;
const AGGRESSION: Record<BotPersonality, number> = { cautious: 0.75, loose: 0.9, aggressive: 1.3, steady: 1 };
const LOOSENESS: Record<BotPersonality, number> = { cautious: 0.8, loose: 1.3, aggressive: 1.15, steady: 1 };

export function decideAtLevel(view: PlayerView, personality: BotPersonality, level: Level, rng: Rng, notes: Notes = {}): Action {
  if (!view.legal) throw new Error("Not this bot's turn");
  let action: Action;
  if (level === "easy") action = easyDecide(view, personality, rng);
  else if (level === "regular") action = regularDecide(view, STYLES[personality], rng);
  else if (level === "hard" && rng.next() < 0.05) action = regularDecide(view, STYLES[personality], rng, 200);
  else action = smartDecide(view, personality, level === "insane", rng, notes);
  return legalize(action, view);
}

function legalize(a: Action, view: PlayerView): Action {
  const l = view.legal!;
  if (a.type === "raise") {
    if (!l.canRaise) return l.canCheck ? { type: "check" } : { type: "call" };
    const to = Math.min(Math.max(a.to, l.minRaiseTo), l.maxRaiseTo);
    return { type: "raise", to };
  }
  if (a.type === "check" && !l.canCheck) return { type: "fold" };
  if (a.type === "call" && l.canCheck) return { type: "check" };
  if (a.type === "fold" && l.canCheck) return { type: "check" };
  return a;
}

function easyDecide(view: PlayerView, personality: BotPersonality, rng: Rng): Action {
  const l = view.legal!;
  // Now and then a beginner just takes the easy option.
  if (rng.next() < 0.12) {
    if (l.canCheck) return { type: "check" };
    return l.toCall <= view.players[view.seat]!.stack * 0.25 ? { type: "call" } : { type: "fold" };
  }
  const s = STYLES[personality];
  return regularDecide(view, {
    looseness: s.looseness + 0.25,
    raiseAt: s.raiseAt + 0.4,
    aggression: s.aggression * 0.45,
    bluff: 0.01,
    callPickiness: s.callPickiness * 0.6,
    sizing: 0.35,
  }, rng, 80);
}

function smartDecide(view: PlayerView, personality: BotPersonality, insane: boolean, rng: Rng, notes: Notes): Action {
  const l = view.legal!;
  const me = view.players[view.seat]!;
  const bb = view.bigBlind;
  const toCall = l.toCall;
  const pot = view.pot;
  const potOdds = toCall / (pot + toCall);
  const opps = view.players.filter((p) => p.id !== view.seat && (p.status === "active" || p.status === "allin"));
  const n = Math.max(1, opps.length);
  const myDepth = me.stack + me.streetBet;
  const eff = Math.min(myDepth, Math.max(...opps.map((p) => p.stack + p.streetBet), 0));
  const agg = AGGRESSION[personality];
  const loose = LOOSENESS[personality] * (insane ? 1 : 0.92);
  const noise = (rng.next() - 0.5) * (insane ? 0.04 : 0.1);
  // Heads-up against one player, insane reads their habits from its notes.
  const solo = insane && opps.length === 1 ? notes[opps[0]!.id] : undefined;
  const folds = solo ? rate(solo.foldedToBet ?? 0, solo.facedBet ?? 0, 0.45, 6) : 0.45;
  const station = solo !== undefined && folds < 0.3;

  const check: Action = { type: "check" };
  const call: Action = { type: "call" };
  const fold: Action = { type: "fold" };
  const shove: Action = { type: "raise", to: l.maxRaiseTo };
  const raiseTo = (to: number): Action => ({ type: "raise", to: to >= l.maxRaiseTo * 0.85 ? l.maxRaiseTo : round5(to) });
  const bet = (frac: number): Action => raiseTo(view.currentBet + Math.max(view.minRaise, (pot + toCall) * frac));
  const giveUp = () => (l.canCheck ? check : fold);

  if (view.street === "preflop") {
    const [a, b] = view.hole;
    const p = preflopPercentile(a!, b!) + noise * 0.5;
    const pre = view.history.filter((x) => x.street === "preflop");
    const raises = pre.filter((x) => x.kind === "raise").length;
    const bbSeat = pre.find((x) => x.kind === "bb")?.seat ?? -1;
    // How many players still to act after me this round (fewer = better position).
    const seats = view.players.length;
    let behind = 0;
    for (let i = 1; i < seats; i++) {
      const s = (view.seat + i) % seats;
      const pl = view.players[s]!;
      if (pl.status === "active" && !pre.some((x) => x.seat === s && x.kind === "fold")) behind++;
      if (s === bbSeat) break;
    }
    const playersDealt = view.players.filter((pl) => pl.status !== "out").length;
    const stackBB = eff / bb;

    // Short stacks: push or fold.
    if (stackBB <= 12) {
      const range = (raises ? 0.08 : 0.12 + (12 - stackBB) * 0.03 + (behind <= 1 ? 0.12 : 0)) * loose;
      if (p <= range) return shove;
      return giveUp();
    }
    if (raises === 0) {
      const open = (playersDealt === 2 ? 0.7 : [0.55, 0.42, 0.32, 0.22, 0.16][Math.min(4, behind)]!) * loose;
      const limpers = pre.filter((x) => x.kind === "call").length;
      if (l.canCheck) {
        // Big blind in a limped pot: raise strong hands, check the rest.
        return p <= open * 0.4 && l.canRaise ? raiseTo(bb * (3.5 + limpers)) : check;
      }
      if (p <= open) return raiseTo(bb * (2.5 + limpers));
      if (personality === "loose" && p <= 0.6 && toCall <= bb) return call;
      if (toCall <= bb / 2 && p <= 0.45) return call; // completing the small blind
      return fold;
    }
    const lastRaise = [...pre].reverse().find((x) => x.kind === "raise")!;
    const raiseSize = lastRaise.amount / bb;
    if (raises === 1) {
      const value = 0.04 * loose;
      // Re-raise as a bluff: sometimes with suited hands, and a lot against players who fold too much.
      const bluffOdds = insane ? Math.min(0.7, Math.max(0.12, (folds - 0.3) * 1.8)) : 0.08;
      const bluff3 = p > 0.06 && p < (insane ? 0.7 : 0.25) && (insane || a!.suit === b!.suit) && rng.next() < bluffOdds * agg;
      let callRange = (0.13 + (behind === 0 ? 0.05 : 0)) * loose * Math.min(1.3, Math.max(0.5, 3 / raiseSize));
      if (potOdds < 0.3) callRange += 0.08;
      if (p <= value || bluff3) return raiseTo(lastRaise.amount * (behind === 0 ? 3 : 3.5));
      if (p <= callRange) return call;
      return giveUp();
    }
    // Facing a re-raise.
    if (p <= 0.02) return stackBB < 40 ? shove : raiseTo(lastRaise.amount * 2.3);
    if (p <= 0.045 * loose) return eff / (pot + toCall) < 3 ? shove : call;
    return giveUp();
  }

  // After the flop: equity against what their betting says they hold.
  const eq = rangeEquity(view, notes, insane, insane ? 450 : 250, rng) + noise;
  const draw = hasDraw(view.hole, view.board);
  const river = view.street === "river";
  const spr = eff / Math.max(1, pot);
  const iRaisedPreflop = [...view.history].reverse().find((x) => x.street === "preflop" && x.kind === "raise")?.seat === view.seat;
  // Against someone who calls everything, bet thinner for value and never bluff.
  const valueAt = (station ? 0.52 : 0.6) + 0.07 * (n - 1);

  // Tight opponents fold more, so bluffs work better against them.
  let foldiness = 0.5;
  if (insane && opps.length === 1) {
    const o = notes[opps[0]!.id];
    if (o) foldiness = 1 - Math.min(0.8, Math.max(0.2, rate(o.vpip, o.hands, 0.45)));
  }

  if (toCall === 0) {
    if (!l.canRaise) return check;
    if (eq >= valueAt) {
      if (insane && eq > 0.9 && !river && rng.next() < 0.15) return check; // slow-play a monster now and then
      return spr < 1.3 ? shove : bet(insane ? (draw || view.board.length < 5 ? 0.75 : 0.6) : 0.66);
    }
    if (eq >= 0.5 && n <= 2 && rng.next() < 0.5 * agg) return bet(0.4);
    if (station) return check;
    if (insane && n === 1 && rng.next() < Math.min(0.85, folds * 1.1) * agg) return bet(0.5); // they fold enough to bet at it
    if (iRaisedPreflop && view.street === "flop" && n <= 2 && rng.next() < (insane ? 0.55 : 0.45) * agg) return bet(0.33);
    if (draw && rng.next() < 0.4 * agg) return bet(0.6);
    if (insane && river && n === 1 && eq < 0.25) {
      // Bluff about as often as a pot-sized bet should be called: balanced, nudged by how foldy they are.
      if (rng.next() < 0.25 * agg * (0.6 + foldiness)) return bet(0.7);
    }
    return check;
  }

  // Facing a bet.
  let need = potOdds;
  if (draw && !river) need -= 0.07; // more to win later when the draw hits
  if (insane && opps.length === 1) {
    const o = notes[opps[0]!.id];
    const aggr = o ? rate(o.bets, o.bets + o.calls, 0.5, 6) : 0.5;
    need -= (aggr - 0.5) * 0.15; // call wider against players who bet a lot
  }
  const strongRaise = n === 1 ? 0.78 : 0.85;
  if (l.canRaise && eq >= strongRaise) return spr < 2 ? shove : raiseTo(view.currentBet * (insane ? 2.8 : 2.5));
  if (l.canRaise && draw && !river && eq >= 0.3 && rng.next() < (insane ? 0.22 : 0.12) * agg) {
    return spr < 2 ? shove : raiseTo(view.currentBet * 2.6);
  }
  if (eq >= need) return call;
  return fold;
}
