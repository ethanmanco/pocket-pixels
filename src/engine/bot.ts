// Computer opponents. A bot only ever gets a PlayerView (its own cards, the
// board and public chip counts), so it decides with the same information a
// person at the table would have.
//
// How a bot decides:
//  1. Hand strength: deal out the rest of the hand a few hundred times at random
//     against the players still in, and count how often it wins.
//  2. Pot odds: compare that win rate with the price of calling.
//  3. Position: play a little looser on the button, which acts last.
//  4. Personality: each style shifts how many hands it plays, how often it
//     raises, how often it bluffs and how big it bets.
//  5. A little randomness, so the same spot does not always get the same answer.

import { type Card, makeDeck, sameCard } from "./cards";
import { score7 } from "./evaluate";
import type { Action, Personality, PlayerView } from "./game";
import { Rng } from "./rng";

export interface BotStyle {
  /** Added to hand strength: positive plays more hands. */
  looseness: number;
  /** Strength (1 = an average hand) needed before it considers raising. */
  raiseAt: number;
  /** Chance it actually raises when strong enough. */
  aggression: number;
  /** Chance of betting or raising with a weak hand. */
  bluff: number;
  /** Multiplies the pot odds it needs to call (below 1 calls too much). */
  callPickiness: number;
  /** Bet size as a fraction of the pot. */
  sizing: number;
}

export const STYLES: Record<Exclude<Personality, "human">, BotStyle> = {
  // Plays few hands, rarely bluffs, gives up when pushed.
  cautious: { looseness: -0.1, raiseAt: 1.45, aggression: 0.6, bluff: 0.02, callPickiness: 1.3, sizing: 0.55 },
  // Plays lots of hands and calls too much, but seldom raises.
  loose: { looseness: 0.15, raiseAt: 1.6, aggression: 0.35, bluff: 0.04, callPickiness: 0.75, sizing: 0.5 },
  // Raises often, bets big, bluffs too much.
  aggressive: { looseness: 0.05, raiseAt: 1.15, aggression: 0.8, bluff: 0.14, callPickiness: 1.0, sizing: 0.85 },
  // Middle of the road: sensible hands, sensible bets, the odd bluff.
  steady: { looseness: 0, raiseAt: 1.35, aggression: 0.6, bluff: 0.06, callPickiness: 1.05, sizing: 0.65 },
};

export type BotPersonality = keyof typeof STYLES;

/** Chance of winning (ties count as a share) against the players still in. */
export function estimateEquity(hole: Card[], board: Card[], opponents: number, iterations: number, rng: Rng): number {
  const known = [...hole, ...board];
  const rest = makeDeck().filter((c) => !known.some((k) => sameCard(k, c)));
  const needBoard = 5 - board.length;
  const draw = needBoard + opponents * 2;
  let wins = 0;
  const mine: Card[] = [...hole, ...board];
  const theirs: Card[] = [];
  for (let i = 0; i < iterations; i++) {
    // Partial shuffle: only the cards we need.
    for (let j = 0; j < draw; j++) {
      const k = j + rng.int(rest.length - j);
      const t = rest[j]!;
      rest[j] = rest[k]!;
      rest[k] = t;
    }
    const runout = rest.slice(0, needBoard);
    mine.length = hole.length + board.length;
    mine.push(...runout);
    const myScore = score7(mine);
    let best = -1;
    let ties = 0;
    for (let o = 0; o < opponents; o++) {
      theirs.length = 0;
      theirs.push(rest[needBoard + o * 2]!, rest[needBoard + o * 2 + 1]!, ...board, ...runout);
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

const round5 = (n: number) => Math.round(n / 5) * 5;

/** Pick an action for the bot whose turn it is. */
export function decide(view: PlayerView, style: BotStyle, rng: Rng, iterations = 300): Action {
  const legal = view.legal;
  if (!legal) throw new Error("Not this bot's turn");
  const me = view.players[view.seat]!;
  const opponents = view.players.filter((p) => p.id !== view.seat && (p.status === "active" || p.status === "allin")).length;

  const equity = estimateEquity(view.hole, view.board, Math.max(1, opponents), iterations, rng);
  const fairShare = 1 / (opponents + 1);
  const onButton = view.dealer === view.seat;
  const noise = (rng.next() - 0.5) * 0.2;
  // 1.0 means an average hand for this many players.
  const strength = equity / fairShare + style.looseness + (onButton ? 0.08 : 0) + noise;

  const toCall = legal.toCall;
  const potAfterCall = view.pot + toCall;
  const potOdds = toCall / potAfterCall;

  const raiseTo = (bluffing: boolean): Action => {
    const size = style.sizing * (0.8 + rng.next() * 0.4) * (bluffing ? 0.8 : 1);
    let to = view.currentBet + Math.max(view.minRaise, round5(potAfterCall * size));
    // When the bet would use most of the stack anyway, just go all-in.
    if (to > legal.maxRaiseTo * 0.6 && !bluffing) to = legal.maxRaiseTo;
    to = Math.min(Math.max(to, legal.minRaiseTo), legal.maxRaiseTo);
    return { type: "raise", to };
  };

  // Facing a big bet needs more strength before raising again.
  const pressure = view.pot > 0 ? toCall / view.pot : 0;
  if (legal.canRaise && strength > style.raiseAt + pressure && rng.next() < style.aggression) {
    return raiseTo(false);
  }
  const cheapEnough = toCall <= view.pot * 0.5;
  if (legal.canRaise && cheapEnough && strength < 1 && rng.next() < style.bluff) {
    return raiseTo(true);
  }
  if (legal.canCheck) return { type: "check" };

  // Calling off most of the stack takes a real hand, especially for careful players.
  const bigCall = toCall > (me.stack + me.streetBet) * 0.4;
  if (bigCall && strength < 1.2 * style.callPickiness) return { type: "fold" };
  if (equity >= potOdds * style.callPickiness) return { type: "call" };
  return { type: "fold" };
}
