// The table screen: runs the game loop (bots act on a timer, you act with the
// buttons) and draws the state as plain DOM.

import { STYLES, decide } from "../engine/bot";
import { type Card, rankName, sameCard } from "../engine/cards";
import { evaluateHand } from "../engine/evaluate";
import {
  type Action, type GameEvent, type GameState, type LegalActions, type Seat,
  applyAction, createGame, isBetweenHands, legalActions, rebuy, startHand, viewFor,
} from "../engine/game";
import { Rng, randomSeed } from "../engine/rng";
import { cardBackEl, cardEl, cardList, emptySlotEl } from "./cards";

const HUMAN = 0;
const START_STACK = 1000;

export interface Opponent {
  name: string;
  personality: "cautious" | "loose" | "aggressive";
  color: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round5 = (n: number) => Math.round(n / 5) * 5;

export class TableApp {
  private state: GameState;
  private rng = new Rng(randomSeed());
  private busy = false;
  /** Board cards shown so far (all-in runouts reveal one street at a time). */
  private shownBoard = 0;
  private message = "";
  private raiseTo = 0;
  private colors: string[];

  private el: {
    seats: HTMLElement; board: HTMLElement; pot: HTMLElement; log: HTMLElement; live: HTMLElement;
    me: HTMLElement; controls: HTMLElement; handNo: HTMLElement;
  };

  constructor(root: HTMLElement, opponents: Opponent[]) {
    this.state = createGame({
      players: [{ name: "You", personality: "human" }, ...opponents],
      stack: START_STACK,
      seed: randomSeed(),
    });
    this.colors = ["#ffd166", ...opponents.map((o) => o.color)];
    root.innerHTML = `
      <header class="topbar">
        <h1 class="title">Pocket Pixels</h1>
        <span class="hand-no" aria-live="off"></span>
      </header>
      <main class="felt" data-players="${opponents.length + 1}">
        <section class="seats" aria-label="Opponents"></section>
        <section class="center">
          <div class="board" role="group" aria-label="Board"></div>
          <div class="pot" aria-live="off"></div>
        </section>
        <p class="log" aria-hidden="true"></p>
        <p class="sr-only" role="status" aria-live="polite"></p>
        <section class="me" aria-label="You"></section>
      </main>
      <footer class="controls" aria-label="Your actions"></footer>`;
    const q = (s: string) => root.querySelector<HTMLElement>(s)!;
    this.el = {
      seats: q(".seats"), board: q(".board"), pot: q(".pot"), log: q(".log"), live: q('[role="status"]'),
      me: q(".me"), controls: q(".controls"), handNo: q(".hand-no"),
    };
    this.render();
  }

  start(): void {
    void this.nextHand();
  }

  // ---------------------------------------------------------------- game loop

  private async nextHand(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    for (const p of this.state.seats) {
      if (p.id !== HUMAN && p.stack === 0) {
        this.state = rebuy(this.state, p.id, START_STACK);
        this.say(`${p.name} rebuys for ${fmt(START_STACK)}.`);
      }
    }
    const r = startHand(this.state);
    this.state = r.state;
    this.shownBoard = 0;
    await this.play(r.events);
  }

  private async rebuyHuman(): Promise<void> {
    this.state = rebuy(this.state, HUMAN, START_STACK);
    this.say(`You rebuy for ${fmt(START_STACK)}.`);
    this.render();
  }

  /** Show what just happened, then keep going until it is your turn or the hand ends. */
  private async play(events: GameEvent[]): Promise<void> {
    this.busy = true;
    for (;;) {
      await this.show(events);
      const h = this.state.hand!;
      if (h.street === "complete" || h.toAct === HUMAN) break;
      const seat = h.toAct!;
      this.render(seat);
      await sleep(550 + this.rng.int(500));
      const bot = this.state.seats[seat]!;
      const style = STYLES[bot.personality as keyof typeof STYLES];
      const action = decide(viewFor(this.state, seat), style, this.rng);
      events = this.apply(seat, action);
    }
    this.busy = false;
    const h = this.state.hand!;
    if (h.toAct === HUMAN) this.prepareRaise(legalActions(this.state, HUMAN));
    this.render();
  }

  private apply(seat: number, action: Action): GameEvent[] {
    const r = applyAction(this.state, seat, action);
    this.state = r.state;
    return r.events;
  }

  private async show(events: GameEvent[]): Promise<void> {
    const h = this.state.hand!;
    let streetsShown = 0;
    for (const e of events) {
      const name = (seat: number) => this.state.seats[seat]!.name;
      switch (e.type) {
        case "handStart":
          this.say(`Hand ${e.handNo}. ${e.dealer === HUMAN ? "You have" : `${name(e.dealer)} has`} the button.`);
          break;
        case "deal": {
          const me = this.state.seats[HUMAN]!;
          if (me.hole.length) this.say(`Your cards: ${cardList(me.hole)}.`);
          break;
        }
        case "action":
          this.say(actionText(name(e.seat), e.seat === HUMAN, e.kind, e.amount, e.allIn));
          break;
        case "returned":
          this.say(`${fmt(e.amount)} uncalled ${e.seat === HUMAN ? "comes back to you" : `goes back to ${name(e.seat)}`}.`);
          break;
        case "street": {
          this.render();
          await sleep(streetsShown++ === 0 ? 450 : 900);
          this.shownBoard += e.cards.length;
          const label = e.street === "flop" ? "Flop" : e.street === "turn" ? "Turn" : "River";
          this.say(`${label}: ${cardList(e.cards)}.`);
          break;
        }
        case "handEnd":
          this.shownBoard = h.board.length;
          for (const line of resultLines(this.state)) this.say(line);
          break;
        case "blind":
          break;
      }
    }
    this.render();
  }

  private say(text: string): void {
    this.message = text;
    // Re-set the live region so repeated text is announced too.
    this.el.live.textContent = "";
    this.el.live.textContent = text;
    this.el.log.textContent = text;
  }

  private act(action: Action): void {
    if (this.busy || this.state.hand?.toAct !== HUMAN) return;
    const events = this.apply(HUMAN, action);
    void this.play(events);
  }

  // ---------------------------------------------------------------- raise sizing

  private prepareRaise(legal: LegalActions): void {
    this.raiseTo = legal.minRaiseTo;
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

  // ---------------------------------------------------------------- drawing

  private render(thinking: number | null = null): void {
    const s = this.state;
    const h = s.hand;
    this.el.handNo.textContent = h ? `Hand ${h.number}` : "";
    this.el.log.textContent = this.message;

    const winners = new Set<number>();
    let winCards: Card[] = [];
    if (h?.result) {
      for (const pot of h.result.pots) pot.winners.forEach((w) => winners.add(w));
      winCards = h.result.pots[0]?.hand?.cards ?? [];
    }
    const isWinCard = (c: Card) => winCards.some((w) => sameCard(w, c));
    const showAll = !!h?.result?.showdown;

    // Opponents
    this.el.seats.replaceChildren(
      ...s.seats.filter((p) => p.id !== HUMAN).map((p, i) => {
        const el = this.seatEl(p, `seat--${seatSlot(i, s.seats.length - 1)}`, thinking === p.id, winners.has(p.id));
        const cards = el.querySelector(".seat-cards")!;
        if (h && p.hole.length && p.status !== "folded") {
          const reveal = showAll && h.result!.hands[p.id];
          for (const c of p.hole) cards.append(reveal ? cardEl(c, "md", isWinCard(c) ? "is-win" : "is-dim") : cardBackEl("md"));
          cards.setAttribute("aria-label", reveal ? `${p.name}'s cards: ${cardList(p.hole)}` : `${p.name}'s cards, face down`);
        }
        return el;
      }),
    );

    // Board
    const board = h ? h.board.slice(0, this.shownBoard) : [];
    const slots: HTMLElement[] = [];
    for (let i = 0; i < 5; i++) {
      const c = board[i];
      slots.push(c ? cardEl(c, "md", showAll ? (isWinCard(c) ? "is-win" : "is-dim") : "") : emptySlotEl("md"));
    }
    this.el.board.replaceChildren(...slots);
    this.el.board.setAttribute("aria-label", board.length ? `Board: ${cardList(board)}` : "Board: no cards yet");

    // Pot: chips already gathered in the middle, plus everything once the hand is over.
    const committed = s.seats.reduce((sum, p) => sum + p.committed, 0);
    const bets = s.seats.reduce((sum, p) => sum + p.streetBet, 0);
    const middle = h?.street === "complete" ? committed : committed - bets;
    this.el.pot.textContent = middle > 0 ? `Pot ${fmt(middle)}` : "";

    // You
    const me = s.seats[HUMAN]!;
    const meEl = this.seatEl(me, "seat--me", false, winners.has(HUMAN));
    const myCards = meEl.querySelector(".seat-cards")!;
    if (h && me.hole.length) {
      for (const c of me.hole) myCards.append(cardEl(c, "lg", showAll ? (isWinCard(c) ? "is-win" : "is-dim") : ""));
      myCards.setAttribute("aria-label", `Your cards: ${cardList(me.hole)}`);
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = me.status === "folded" ? "You folded" : handHint(me.hole, board);
      meEl.append(hint);
    }
    this.el.me.replaceChildren(meEl);

    this.renderControls();
  }

  private seatEl(p: Seat, slotClass: string, thinking: boolean, winner: boolean): HTMLElement {
    const h = this.state.hand;
    const el = document.createElement("div");
    const toAct = h?.toAct === p.id && h.street !== "complete";
    el.className = [
      "seat", slotClass, toAct ? "is-turn" : "", p.status === "folded" ? "is-folded" : "",
      p.status === "out" ? "is-out" : "", winner ? "is-winner" : "",
    ].filter(Boolean).join(" ");
    const isMe = p.id === HUMAN;
    const tag = p.status === "allin" ? "All in" : p.status === "folded" ? "Fold" : p.lastAction ? tagText(p.lastAction.kind) : "";
    const status = [
      `${isMe ? "You have" : `${p.name} has`} ${fmt(p.stack)} chips`,
      h?.dealer === p.id ? "dealer button" : "",
      p.streetBet ? `bet ${fmt(p.streetBet)}` : "",
      tag && !isMe ? tag.toLowerCase() : "",
      thinking ? "thinking" : "",
    ].filter(Boolean).join(", ");
    el.setAttribute("aria-label", status);
    el.innerHTML = `
      <div class="avatar" style="--c:${this.colors[p.id]}" aria-hidden="true">${p.name[0]}</div>
      <div class="seat-info" aria-hidden="true">
        <span class="name">${p.name}</span>
        <span class="stack">${fmt(p.stack)}</span>
      </div>
      <div class="seat-cards" role="group"></div>
      ${h?.dealer === p.id ? '<span class="dealer" aria-hidden="true">D</span>' : ""}
      ${tag ? `<span class="tag" aria-hidden="true">${tag}</span>` : ""}
      ${thinking ? '<span class="thinking" aria-hidden="true"><i></i><i></i><i></i></span>' : ""}
      ${p.streetBet ? `<span class="bet" aria-hidden="true">${fmt(p.streetBet)}</span>` : ""}`;
    return el;
  }

  private renderControls(): void {
    const s = this.state;
    const h = s.hand;
    const c = this.el.controls;

    // Wait for any runout to finish dealing before offering the next hand.
    if (!h || (isBetweenHands(s) && !this.busy)) {
      const broke = s.seats[HUMAN]!.stack === 0;
      c.innerHTML = broke
        ? `<p class="controls-note">You are out of chips.</p><div class="row"><button class="btn btn--go" data-do="rebuy">Rebuy ${fmt(START_STACK)}</button></div>`
        : `<div class="row"><button class="btn btn--go" data-do="deal">${h ? "Next hand" : "Deal"}</button></div>`;
      c.querySelector<HTMLButtonElement>("[data-do]")!.onclick = () => {
        if (broke) void this.rebuyHuman();
        else void this.nextHand();
      };
      return;
    }

    const myTurn = h.toAct === HUMAN && !this.busy;
    if (!myTurn) {
      const waiting = h.toAct !== null ? `Waiting for ${s.seats[h.toAct]!.name}` : "";
      c.innerHTML = `
        <div class="row row--quick" aria-hidden="true"></div>
        <p class="controls-note">${waiting}</p>
        <div class="row"><button class="btn" disabled>Fold</button><button class="btn" disabled>Check</button><button class="btn" disabled>Raise</button></div>`;
      return;
    }

    const legal = legalActions(s, HUMAN);
    this.raiseTo = Math.min(Math.max(this.raiseTo, legal.minRaiseTo), legal.maxRaiseTo);
    const word = legal.isBet ? "Bet" : "Raise to";
    const raiseLabel = () => (this.raiseTo === legal.maxRaiseTo ? `All in ${fmt(this.raiseTo)}` : `${word} ${fmt(this.raiseTo)}`);
    const callIsAllIn = legal.toCall === s.seats[HUMAN]!.stack;

    c.innerHTML = `
      ${legal.canRaise ? `
      <div class="row row--quick">
        <button class="btn btn--small" data-preset="min">Min</button>
        <button class="btn btn--small" data-preset="half">1/2 pot</button>
        <button class="btn btn--small" data-preset="pot">Pot</button>
        <button class="btn btn--small" data-preset="all">All in</button>
      </div>
      <div class="row row--slider">
        <input type="range" class="slider" min="${legal.minRaiseTo}" max="${legal.maxRaiseTo}" step="1" value="${this.raiseTo}" aria-label="Raise amount">
      </div>` : `<div class="row row--quick" aria-hidden="true"></div>`}
      <div class="row">
        <button class="btn btn--fold" data-act="fold" ${legal.canCheck ? "disabled" : ""}>Fold</button>
        <button class="btn btn--call" data-act="${legal.canCheck ? "check" : "call"}">${
          legal.canCheck ? "Check" : callIsAllIn ? `All in ${fmt(legal.toCall)}` : `Call ${fmt(legal.toCall)}`
        }</button>
        <button class="btn btn--raise" data-act="raise" ${legal.canRaise ? "" : "disabled"}>${legal.canRaise ? raiseLabel() : "Raise"}</button>
      </div>`;

    const raiseBtn = c.querySelector<HTMLButtonElement>('[data-act="raise"]')!;
    const slider = c.querySelector<HTMLInputElement>(".slider");
    const setTo = (to: number) => {
      this.raiseTo = to;
      if (slider) slider.value = String(to);
      raiseBtn.textContent = raiseLabel();
    };
    slider?.addEventListener("input", () => {
      const v = Number(slider.value);
      // Snap to multiples of 5, but let the very ends stay reachable.
      setTo(v >= legal.maxRaiseTo ? legal.maxRaiseTo : Math.max(legal.minRaiseTo, round5(v)));
    });
    c.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => {
      b.onclick = () => setTo(this.presetTo(b.dataset.preset as "min" | "half" | "pot" | "all", legal));
    });
    c.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
      b.onclick = () => {
        const kind = b.dataset.act!;
        if (kind === "raise") this.act({ type: "raise", to: this.raiseTo });
        else this.act({ type: kind as "fold" | "check" | "call" });
      };
    });
  }
}

/** Where an opponent sits: heads-up straight across, otherwise left, top, right. */
function seatSlot(index: number, opponents: number): string {
  if (opponents === 1) return "top";
  return ["left", "top", "right"][index] ?? "top";
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

function resultLines(state: GameState): string[] {
  const r = state.hand!.result!;
  const name = (seat: number) => (seat === HUMAN ? "You" : state.seats[seat]!.name);
  const verb = (seat: number) => (seat === HUMAN ? "win" : "wins");
  const lines = r.pots.map((pot, i) => {
    const label = r.pots.length > 1 ? (i === 0 ? "Main pot: " : `Side pot ${r.pots.length > 2 ? i : ""}: `.replace(" :", ":")) : "";
    const how = pot.handText ? ` with ${lowerFirst(pot.handText)}` : "";
    if (pot.winners.length > 1) {
      const names = pot.winners.map(name).join(" and ");
      return `${label}Split pot. ${names} each win ${fmt(pot.shares[pot.winners.length - 1]!)}${how}.`;
    }
    const w = pot.winners[0]!;
    return `${label}${name(w)} ${verb(w)} ${fmt(pot.amount)}${how}.`;
  });
  return [lines.join(" ")];
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
  return `${cap(rankName(hi.rank))}, ${rankName(lo.rank)}${a.suit === b.suit ? " suited" : ""}`;
}

function cap(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}
