// The table screen. It runs the hand loop (asking each seat's driver for an
// action), animates chips, and draws everything as plain DOM.
//
// Layout, top to bottom: opponents along the top arc (with their bets below
// them), the board and pot in the middle, your bet, then you.

import { type BotPersonality, STYLES } from "../engine/bot";
import { type Card, rankName, sameCard } from "../engine/cards";
import { evaluateHand } from "../engine/evaluate";
import {
  type GameEvent, type GameState, type LegalActions, type Seat,
  applyAction, createGame, isBetweenHands, rebuy, startHand, viewFor,
} from "../engine/game";
import { Rng, randomSeed } from "../engine/rng";
import { cardBackEl, cardEl, cardList, emptySlotEl } from "./cards";
import { chipsSVG, pileColumns, stackColumn } from "./chips";
import { BotDriver, LocalDriver, type SeatDriver } from "./drivers";
import { slide } from "./motion";
import { reducedMotion, sleep } from "./timing";

const HUMAN = 0;
const START_STACK = 1000;

export interface Opponent {
  name: string;
  personality: BotPersonality;
  color: string;
}

/**
 * Where an opponent sits in the top area: x in percent of the width, y in
 * pixels from the top (seat's top edge), and the center of its bet (bx %, by px).
 */
interface Slot { x: number; y: number; bx: number; by: number }

// Opponents sit clockwise from your left. One layout per table size.
const OPPONENT_SLOTS: Record<number, Slot[]> = {
  1: [{ x: 50, y: 14, bx: 50, by: 134 }],
  2: [{ x: 32, y: 14, bx: 32, by: 134 }, { x: 68, y: 14, bx: 68, by: 134 }],
  3: [{ x: 14, y: 52, bx: 14, by: 166 }, { x: 50, y: 12, bx: 50, by: 130 }, { x: 86, y: 52, bx: 86, by: 166 }],
  4: [
    { x: 13, y: 52, bx: 13, by: 166 }, { x: 37, y: 12, bx: 37, by: 130 },
    { x: 63, y: 12, bx: 63, by: 130 }, { x: 87, y: 52, bx: 87, by: 166 },
  ],
};
const CHIP_SCALE = 3;

const fmt = (n: number) => n.toLocaleString("en-US");
const round5 = (n: number) => Math.round(n / 5) * 5;

export class TableApp {
  private state: GameState;
  private rng = new Rng(randomSeed());
  private drivers: SeatDriver[];
  private local: LocalDriver;
  private colors: string[];
  private slots: Slot[];

  /** A hand is being played or animated. */
  private running = false;
  /** Seat whose bot is thinking, for the dots. */
  private thinking: number | null = null;
  /** Board cards shown so far (all-in runouts reveal one street at a time). */
  private shownBoard = 0;
  /** Chips shown in front of each player this street (lags the engine while chips animate). */
  private bets: number[];
  private drawnBets: number[];
  /** Winnings not yet slid over to the winners' stacks. */
  private pendingWin: number[] | null = null;
  private message = "";
  private raiseTo = 0;

  private el: {
    felt: HTMLElement; upper: HTMLElement; board: HTMLElement; pot: HTMLElement; myBet: HTMLElement;
    me: HTMLElement; log: HTMLElement; live: HTMLElement; controls: HTMLElement; handNo: HTMLElement;
  };

  constructor(root: HTMLElement, opponents: Opponent[]) {
    this.state = createGame({
      players: [{ name: "You", personality: "human" }, ...opponents],
      stack: START_STACK,
      seed: randomSeed(),
    });
    const n = this.state.seats.length;
    this.colors = ["#ffd166", ...opponents.map((o) => o.color)];
    this.slots = OPPONENT_SLOTS[opponents.length] ?? OPPONENT_SLOTS[4]!;
    this.bets = new Array<number>(n).fill(0);
    this.drawnBets = [...this.bets];

    this.local = new LocalDriver(() => {
      this.raiseTo = this.local.waitingFor?.minRaiseTo ?? 0;
      this.render();
    });
    this.drivers = [
      this.local,
      ...opponents.map((o) => new BotDriver(STYLES[o.personality], this.rng, () => 450 + this.rng.int(450))),
    ];

    root.innerHTML = `
      <header class="topbar">
        <h1 class="title">Pocket Pixels</h1>
        <span class="hand-no"></span>
      </header>
      <main class="felt" aria-label="Poker table">
        <div class="upper"></div>
        <div class="middle">
          <div class="board" role="group" aria-label="Board"></div>
          <div class="pot"></div>
        </div>
        <div class="my-bet" aria-hidden="true"></div>
        <div class="me"></div>
      </main>
      <p class="log" aria-hidden="true"></p>
      <p class="sr-only" role="status" aria-live="polite"></p>
      <footer class="controls" aria-label="Your actions"></footer>`;
    const q = (s: string) => root.querySelector<HTMLElement>(s)!;
    this.el = {
      felt: q(".felt"), upper: q(".upper"), board: q(".board"), pot: q(".pot"), myBet: q(".my-bet"), me: q(".me"),
      log: q(".log"), live: q('[role="status"]'), controls: q(".controls"), handNo: q(".hand-no"),
    };
    this.render();
  }

  start(): void {
    void this.playHand();
  }

  // ---------------------------------------------------------------- hand loop

  private async playHand(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const p of this.state.seats) {
      if (p.id !== HUMAN && p.stack === 0) {
        this.state = rebuy(this.state, p.id, START_STACK);
        this.say(`${p.name} rebuys for ${fmt(START_STACK)}.`);
      }
    }
    const r = startHand(this.state);
    this.state = r.state;
    this.shownBoard = 0;
    await this.show(r.events);

    while (this.state.hand!.street !== "complete") {
      const seat = this.state.hand!.toAct!;
      const driver = this.drivers[seat]!;
      this.thinking = driver.kind === "bot" ? seat : null;
      this.render();
      const action = await driver.decide(viewFor(this.state, seat));
      this.thinking = null;
      const step = applyAction(this.state, seat, action);
      this.state = step.state;
      await this.show(step.events);
    }
    this.running = false;
    this.render();
  }

  private async show(events: GameEvent[]): Promise<void> {
    const h = this.state.hand!;
    const name = (seat: number) => this.state.seats[seat]!.name;
    let streets = 0;
    for (const e of events) {
      switch (e.type) {
        case "handStart":
          this.bets.fill(0);
          this.drawnBets.fill(0);
          this.say(`Hand ${e.handNo}. ${e.dealer === HUMAN ? "You have" : `${name(e.dealer)} has`} the button.`);
          break;
        case "blind":
          this.bets[e.seat] = e.amount;
          break;
        case "deal": {
          const me = this.state.seats[HUMAN]!;
          if (me.hole.length) this.say(`Your cards: ${cardList(me.hole)}.`);
          this.render();
          break;
        }
        case "action":
          this.bets[e.seat] = e.amount;
          this.say(actionText(name(e.seat), e.seat === HUMAN, e.kind, e.amount, e.allIn));
          this.render();
          break;
        case "returned":
          this.bets[e.seat] = Math.max(0, this.bets[e.seat]! - e.amount);
          this.say(`${fmt(e.amount)} uncalled ${e.seat === HUMAN ? "comes back to you" : `goes back to ${name(e.seat)}`}.`);
          this.render();
          break;
        case "street": {
          await sleep(streets++ === 0 ? 250 : 800);
          await this.gatherBets();
          this.shownBoard += e.cards.length;
          const label = e.street === "flop" ? "Flop" : e.street === "turn" ? "Turn" : "River";
          this.say(`${label}: ${cardList(e.cards)}.`);
          this.render();
          break;
        }
        case "handEnd":
          await sleep(250);
          this.pendingWin = [...e.result.won];
          await this.gatherBets();
          this.shownBoard = h.board.length;
          this.say(resultText(this.state));
          this.render();
          await sleep(e.result.showdown ? 1100 : 500);
          await this.slideWinnings();
          this.pendingWin = null;
          this.render();
          break;
      }
    }
  }

  private say(text: string): void {
    this.message = text;
    // Re-set the live region so repeated text is announced too.
    this.el.live.textContent = "";
    this.el.live.textContent = text;
    this.el.log.textContent = text;
  }

  // ---------------------------------------------------------------- chip animation

  private seatNode(seat: number): HTMLElement | null {
    return this.el.felt.querySelector<HTMLElement>(`.seat[data-seat="${seat}"]`);
  }

  /** Slide every bet into the pot. */
  private async gatherBets(): Promise<void> {
    if (!this.bets.some((b) => b > 0)) return;
    if (!reducedMotion()) {
      const bets = [...this.el.felt.querySelectorAll<HTMLElement>(".bet")];
      await Promise.all(bets.map((el) => slide(el, el, this.el.pot, { duration: 320, fade: "out" })));
    }
    this.bets.fill(0);
    this.drawnBets.fill(0);
    this.render();
  }

  /** Slide the pot to the winners. */
  private async slideWinnings(): Promise<void> {
    const won = this.pendingWin;
    if (!won || reducedMotion() || !this.el.pot.querySelector(".chips-svg")) return;
    const feltBox = this.el.felt.getBoundingClientRect();
    const potBox = this.el.pot.getBoundingClientRect();
    const moves = won.flatMap((w, seat) => {
      const target = w > 0 ? this.seatNode(seat) : null;
      if (!target) return [];
      // A copy of the pile, pinned over the real one, travels to each winner.
      const ghost = this.el.pot.cloneNode(true) as HTMLElement;
      ghost.classList.add("pot--ghost");
      Object.assign(ghost.style, {
        left: `${potBox.left - feltBox.left - this.el.felt.clientLeft}px`,
        top: `${potBox.top - feltBox.top - this.el.felt.clientTop}px`,
        width: `${potBox.width}px`,
        height: `${potBox.height}px`,
      });
      this.el.felt.append(ghost);
      return [slide(ghost, ghost, target, { duration: 480, fade: "out", shrink: true }).then(() => ghost.remove())];
    });
    this.el.pot.style.visibility = "hidden";
    await Promise.all(moves);
    this.el.pot.style.visibility = "";
  }

  // ---------------------------------------------------------------- drawing

  private render(): void {
    const s = this.state;
    const h = s.hand;
    this.el.handNo.textContent = h ? `Hand ${h.number}` : "";
    this.el.log.textContent = this.message;

    const result = h?.result ?? null;
    const winners = new Set<number>();
    if (result && this.pendingWin !== null) for (const pot of result.pots) pot.winners.forEach((w) => winners.add(w));
    const winCards = result?.pots[0]?.hand?.cards ?? [];
    const showdown = !!result?.showdown;
    const mark = (c: Card) => (showdown ? (winCards.some((w) => sameCard(w, c)) ? "is-win" : "is-dim") : "");

    // Seats and bets
    const upper: HTMLElement[] = [];
    const newBets: [HTMLElement, number][] = [];
    for (const p of s.seats) {
      const seatEl = this.seatEl(p, winners.has(p.id), mark);
      const betEl = this.betEl(p.id);
      if (p.id === HUMAN) {
        this.el.me.replaceChildren(seatEl);
        this.el.myBet.replaceChildren(...(betEl ? [betEl] : []));
      } else {
        const slot = this.slots[p.id - 1]!;
        seatEl.style.left = `${slot.x}%`;
        seatEl.style.top = `${slot.y}px`;
        upper.push(seatEl);
        if (betEl) {
          betEl.classList.add("bet--placed");
          betEl.style.left = `${slot.bx}%`;
          betEl.style.top = `${slot.by}px`;
          upper.push(betEl);
        }
      }
      if (betEl && this.bets[p.id]! > this.drawnBets[p.id]!) newBets.push([betEl, p.id]);
    }
    this.el.upper.replaceChildren(...upper);
    this.drawnBets = [...this.bets];
    if (!reducedMotion()) {
      for (const [betEl, seat] of newBets) {
        const from = this.seatNode(seat);
        if (from) void slide(betEl, from, betEl, { duration: 260, fade: "in" });
      }
    }

    // Board
    const board = h ? h.board.slice(0, this.shownBoard) : [];
    const slots: HTMLElement[] = [];
    for (let i = 0; i < 5; i++) {
      const c = board[i];
      slots.push(c ? cardEl(c, "md", mark(c)) : emptySlotEl("md"));
    }
    this.el.board.replaceChildren(...slots);
    this.el.board.setAttribute("aria-label", board.length ? `Board: ${cardList(board)}` : "Board: no cards yet");

    // Pot: chips gathered in the middle (bets still in front of players are not in it yet).
    const committed = s.seats.reduce((sum, p) => sum + p.committed, 0);
    const pending = this.bets.reduce((sum, b) => sum + b, 0);
    const finished = h?.street === "complete" && this.pendingWin === null;
    const pot = h && !finished ? committed - pending : 0;
    this.el.pot.innerHTML = pot > 0
      ? `<span class="pot-amount">Pot ${fmt(pot)}</span>${chipsSVG(pileColumns(pot, 6, 6), CHIP_SCALE)}`
      : "";
    this.el.pot.setAttribute("aria-label", pot > 0 ? `Pot ${fmt(pot)}` : "");

    this.renderControls();
  }

  private betEl(seat: number): HTMLElement | null {
    const amount = this.bets[seat]!;
    if (amount <= 0) return null;
    const el = document.createElement("div");
    el.className = "bet";
    el.dataset.seat = String(seat);
    el.innerHTML = `${chipsSVG([stackColumn(amount, 4)], CHIP_SCALE)}<span class="bet-amount">${fmt(amount)}</span>`;
    return el;
  }

  private seatEl(p: Seat, winner: boolean, mark: (c: Card) => string): HTMLElement {
    const h = this.state.hand;
    const isMe = p.id === HUMAN;
    const el = document.createElement("div");
    el.dataset.seat = String(p.id);
    const toAct = !!h && h.toAct === p.id && h.street !== "complete";
    el.className = [
      "seat", isMe ? "seat--me" : "seat--opp", toAct ? "is-turn" : "", p.status === "folded" ? "is-folded" : "",
      p.status === "out" ? "is-out" : "", winner ? "is-winner" : "",
    ].filter(Boolean).join(" ");

    const stack = p.stack - (this.pendingWin?.[p.id] ?? 0);
    const tag = p.status === "allin" ? "All in" : p.status === "folded" ? "Fold" : p.lastAction ? tagText(p.lastAction.kind) : "";
    const thinking = this.thinking === p.id;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", [
      isMe ? "You" : p.name,
      `${fmt(stack)} chips`,
      h?.dealer === p.id ? "dealer button" : "",
      this.bets[p.id] ? `bet ${fmt(this.bets[p.id]!)}` : "",
      tag && !isMe ? tag.toLowerCase() : "",
      thinking ? "thinking" : "",
    ].filter(Boolean).join(", "));

    const extras = `
      ${h?.dealer === p.id ? '<span class="dealer" aria-hidden="true">D</span>' : ""}
      ${tag && !isMe ? `<span class="tag" aria-hidden="true">${tag}</span>` : ""}
      ${thinking ? '<span class="thinking" aria-hidden="true"><i></i><i></i><i></i></span>' : ""}`;
    const info = `
      <div class="seat-info" aria-hidden="true">
        <span class="name">${p.name}</span>
        <span class="stack">${fmt(stack)}</span>
      </div>`;
    el.innerHTML = isMe
      ? `<div class="seat-cards"></div><div class="seat-side">${info}</div>${extras}`
      : `<div class="seat-top"><div class="avatar" style="--c:${this.colors[p.id]}" aria-hidden="true">${p.name[0]}</div><div class="seat-cards"></div></div>${info}${extras}`;

    const cards = el.querySelector<HTMLElement>(".seat-cards")!;
    if (h && p.hole.length && p.status !== "folded") {
      if (isMe) {
        for (const c of p.hole) cards.append(cardEl(c, "lg", mark(c)));
        cards.setAttribute("aria-label", `Your cards: ${cardList(p.hole)}`);
      } else {
        const reveal = !!h.result?.showdown && !!h.result.hands[p.id];
        for (const c of p.hole) cards.append(reveal ? cardEl(c, "sm", mark(c)) : cardBackEl("sm"));
        cards.setAttribute("aria-label", reveal ? `${p.name}'s cards: ${cardList(p.hole)}` : `${p.name}'s cards, face down`);
      }
      cards.setAttribute("role", "group");
    }
    if (isMe && h && p.hole.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = p.status === "folded" ? "You folded" : handHint(p.hole, h.board.slice(0, this.shownBoard));
      el.querySelector(".seat-side")!.append(hint);
    }
    return el;
  }

  private renderControls(): void {
    const s = this.state;
    const c = this.el.controls;
    const legal = this.local.waitingFor;

    if (!this.running && (!s.hand || isBetweenHands(s))) {
      const broke = s.seats[HUMAN]!.stack === 0;
      c.innerHTML = `
        <div class="row row--quick"></div>
        <p class="controls-note">${broke ? "You are out of chips." : ""}</p>
        <div class="row"><button class="btn btn--go" data-do="next">${broke ? `Rebuy ${fmt(START_STACK)}` : s.hand ? "Next hand" : "Deal"}</button></div>`;
      c.querySelector<HTMLButtonElement>("[data-do]")!.onclick = () => {
        if (broke) {
          this.state = rebuy(this.state, HUMAN, START_STACK);
          this.say(`You rebuy for ${fmt(START_STACK)}.`);
          this.render();
        } else void this.playHand();
      };
      return;
    }

    if (!legal) {
      const h = s.hand;
      const waiting = h && h.toAct !== null && h.street !== "complete" ? `Waiting for ${s.seats[h.toAct]!.name}` : "";
      c.innerHTML = `
        <div class="row row--quick"></div>
        <p class="controls-note">${waiting}</p>
        <div class="row"><button class="btn" disabled>Fold</button><button class="btn" disabled>Check</button><button class="btn" disabled>Raise</button></div>`;
      return;
    }

    this.raiseTo = Math.min(Math.max(this.raiseTo, legal.minRaiseTo), legal.maxRaiseTo);
    const word = legal.isBet ? "Bet" : "Raise to";
    const raiseLabel = () => label(this.raiseTo === legal.maxRaiseTo ? "All in" : word, this.raiseTo);
    const callIsAllIn = legal.toCall === s.seats[HUMAN]!.stack;

    c.innerHTML = `
      <div class="row row--quick">${legal.canRaise ? `
        <button class="btn btn--small" data-preset="min">Min</button>
        <button class="btn btn--small" data-preset="half">1/2 pot</button>
        <button class="btn btn--small" data-preset="pot">Pot</button>
        <button class="btn btn--small" data-preset="all">All in</button>` : ""}
      </div>
      <div class="row row--slider">${legal.canRaise ? `
        <input type="range" class="slider" min="${legal.minRaiseTo}" max="${legal.maxRaiseTo}" step="1" value="${this.raiseTo}" aria-label="Raise amount">` : ""}
      </div>
      <div class="row">
        <button class="btn btn--fold" data-act="fold" ${legal.canCheck ? "disabled" : ""}>Fold</button>
        <button class="btn btn--call" data-act="${legal.canCheck ? "check" : "call"}">${
          legal.canCheck ? "Check" : label(callIsAllIn ? "All in" : "Call", legal.toCall)
        }</button>
        <button class="btn btn--raise" data-act="raise" ${legal.canRaise ? "" : "disabled"}>${legal.canRaise ? raiseLabel() : "Raise"}</button>
      </div>`;

    const raiseBtn = c.querySelector<HTMLButtonElement>('[data-act="raise"]')!;
    const slider = c.querySelector<HTMLInputElement>(".slider");
    const setTo = (to: number) => {
      this.raiseTo = to;
      if (slider) slider.value = String(to);
      raiseBtn.innerHTML = raiseLabel();
    };
    slider?.addEventListener("input", () => {
      const v = Number(slider.value);
      // Snap to multiples of 5, but keep both ends reachable.
      setTo(v >= legal.maxRaiseTo ? legal.maxRaiseTo : Math.max(legal.minRaiseTo, round5(v)));
    });
    c.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => {
      b.onclick = () => setTo(this.presetTo(b.dataset.preset as "min" | "half" | "pot" | "all", legal));
    });
    c.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
      b.onclick = () => {
        const kind = b.dataset.act!;
        if (kind === "raise") this.local.submit({ type: "raise", to: this.raiseTo });
        else this.local.submit({ type: kind as "fold" | "check" | "call" });
      };
    });
  }

  private presetTo(kind: "min" | "half" | "pot" | "all", legal: LegalActions): number {
    const h = this.state.hand!;
    const pot = this.state.seats.reduce((s, p) => s + p.committed, 0);
    const afterCall = pot + legal.toCall;
    let to: number;
    if (kind === "min") to = legal.minRaiseTo;
    else if (kind === "all") to = legal.maxRaiseTo;
    else to = h.currentBet + round5(afterCall * (kind === "half" ? 0.5 : 1));
    return Math.min(Math.max(to, legal.minRaiseTo), legal.maxRaiseTo);
  }
}

/** Two-line button text: a small verb over a big amount. */
function label(verb: string, amount: number): string {
  return `<span class="btn-verb">${verb}</span><span class="btn-amount">${fmt(amount)}</span>`;
}

function tagText(kind: string): string {
  switch (kind) {
    case "sb": return "SB";
    case "bb": return "BB";
    default: return kind[0]!.toUpperCase() + kind.slice(1);
  }
}

function actionText(name: string, isMe: boolean, kind: string, amount: number, allIn: boolean): string {
  const who = isMe ? "You" : name;
  const s = isMe ? "" : "s";
  if (allIn && kind !== "fold" && kind !== "check") return `${who} ${isMe ? "go" : "goes"} all in for ${fmt(amount)}.`;
  switch (kind) {
    case "fold": return `${who} fold${s}.`;
    case "check": return `${who} check${s}.`;
    case "call": return `${who} call${s} ${fmt(amount)}.`;
    case "bet": return `${who} bet${s} ${fmt(amount)}.`;
    default: return `${who} raise${s} to ${fmt(amount)}.`;
  }
}

function resultText(state: GameState): string {
  const r = state.hand!.result!;
  const name = (seat: number) => (seat === HUMAN ? "You" : state.seats[seat]!.name);
  const verb = (seat: number) => (seat === HUMAN ? "win" : "wins");
  const first = r.pots[0]!;
  // One player took every pot: say it once, with the total.
  if (first.winners.length === 1 && r.pots.every((p) => p.winners.length === 1 && p.winners[0] === first.winners[0])) {
    const w = first.winners[0]!;
    const total = r.pots.reduce((s, p) => s + p.amount, 0);
    return `${name(w)} ${verb(w)} ${fmt(total)}${first.handText ? ` with ${lowerFirst(first.handText)}` : ""}.`;
  }
  return r.pots
    .map((pot, i) => {
      const label = r.pots.length > 1 ? (i === 0 ? "Main pot: " : r.pots.length > 2 ? `Side pot ${i}: ` : "Side pot: ") : "";
      const how = pot.handText ? ` with ${lowerFirst(pot.handText)}` : "";
      if (pot.winners.length > 1) {
        return `${label}Split. ${pot.winners.map(name).join(" and ")} each win ${fmt(pot.shares[pot.winners.length - 1]!)}${how}.`;
      }
      const w = pot.winners[0]!;
      return `${label}${name(w)} ${verb(w)} ${fmt(pot.amount)}${how}.`;
    })
    .join(" ");
}

function lowerFirst(s: string): string {
  return s[0]!.toLowerCase() + s.slice(1);
}

/** Short description of your current hand under your cards. */
function handHint(hole: Card[], board: Card[]): string {
  if (board.length >= 3) return evaluateHand([...hole, ...board]).name;
  const [a, b] = hole;
  if (!a || !b) return "";
  if (a.rank === b.rank) return `Pair of ${rankName(a.rank, true)}`;
  const hi = a.rank > b.rank ? a : b;
  const lo = hi === a ? b : a;
  const name = rankName(hi.rank);
  return `${name[0]!.toUpperCase()}${name.slice(1)}, ${rankName(lo.rank)}${a.suit === b.suit ? " suited" : ""}`;
}
