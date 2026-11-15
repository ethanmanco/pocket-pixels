// The table screen. It runs the hand loop (asking each seat's driver for an
// action), animates cards and chips, plays sounds, keeps your chips and stats,
// and draws everything as plain DOM.
//
// Layout, top to bottom: opponents along the top arc (with their bets below
// them), the board and pot in the middle, your bet, then you.

import { type BotPersonality, STYLES } from "../engine/bot";
import { type Card, cardCode, parseCard, rankName, sameCard } from "../engine/cards";
import { evaluateHand } from "../engine/evaluate";
import {
  type GameEvent, type GameState, type LegalActions, type Seat,
  applyAction, createGame, isBetweenHands, rebuy, startHand, viewFor,
} from "../engine/game";
import { Rng, randomSeed } from "../engine/rng";
import { avatarBg, avatarSVG } from "./avatars";
import { cardBackEl, cardEl, cardList, emptySlotEl } from "./cards";
import { chipsSVG, pileColumns, stackColumn } from "./chips";
import { BotDriver, LocalDriver, type SeatDriver } from "./drivers";
import { flipIn, slide } from "./motion";
import { pixelSVG } from "./pixels";
import { isMuted, setMuted, sfx, unlockAudio } from "./sfx";
import { type Saved, START_STACK, emptyStats, load, save } from "./storage";
import { paintTable } from "./table";
import { reducedMotion, sleep } from "./timing";

const HUMAN = 0;

export interface Opponent {
  name: string;
  personality: BotPersonality;
  avatar: string;
}

/**
 * Where an opponent sits in the top area: x in percent of the width, y in
 * pixels from the top (seat's top edge), and the center of its bet (bx %, by px).
 */
interface Slot { x: number; y: number; bx: number; by: number }

// Opponents sit clockwise from your left. One layout per table size.
const OPPONENT_SLOTS: Record<number, Slot[]> = {
  1: [{ x: 50, y: 18, bx: 50, by: 138 }],
  2: [{ x: 32, y: 18, bx: 32, by: 138 }, { x: 68, y: 18, bx: 68, by: 138 }],
  3: [{ x: 15, y: 56, bx: 15, by: 170 }, { x: 50, y: 16, bx: 50, by: 134 }, { x: 85, y: 56, bx: 85, by: 170 }],
  4: [
    { x: 14, y: 56, bx: 14, by: 170 }, { x: 37, y: 16, bx: 37, by: 134 },
    { x: 63, y: 16, bx: 63, by: 134 }, { x: 86, y: 56, bx: 86, by: 170 },
  ],
};

/** Which opponents sit at smaller tables (seating order is kept). */
const TABLE_PICKS: Record<number, string[]> = {
  2: ["Blaze"],
  3: ["Pebble", "Blaze"],
  4: ["Pebble", "Juniper", "Blaze"],
  5: ["Pebble", "Juniper", "Blaze", "Rook"],
};

const CHIP_SCALE = 3;

const ICONS = {
  soundOn: ["....X.....", "...XX..X..", "XXXXX...X.", "XXXXX.X.X.", "XXXXX.X.X.", "XXXXX...X.", "...XX..X..", "....X....."],
  soundOff: ["....X.....", "...XX.....", "XXXXX.X.X.", "XXXXX..X..", "XXXXX.X.X.", "XXXXX.....", "...XX.....", "....X....."],
  menu: ["XXXXXXXXX", "XXXXXXXXX", ".........", "XXXXXXXXX", "XXXXXXXXX", ".........", "XXXXXXXXX", "XXXXXXXXX"],
};
const icon = (rows: string[]) => pixelSVG(rows, { X: "currentColor" }, 3, "icon");

const fmt = (n: number) => n.toLocaleString("en-US");
const round5 = (n: number) => Math.round(n / 5) * 5;

export class TableApp {
  private state!: GameState;
  private rng = new Rng(randomSeed());
  private drivers: SeatDriver[] = [];
  private local: LocalDriver;
  private avatars: string[] = [];
  private slots: Slot[] = [];
  private saved: Saved;
  private pendingSize: number | null = null;

  /** A hand is being played or animated. */
  private running = false;
  /** Seat whose bot is thinking, for the dots. */
  private thinking: number | null = null;
  /** Board cards shown so far (all-in runouts reveal one street at a time). */
  private shownBoard = 0;
  /** Chips shown in front of each player this street (lags the engine while chips animate). */
  private bets: number[] = [];
  private drawnBets: number[] = [];
  /** Winnings not yet slid over to the winners' stacks. */
  private pendingWin: number[] | null = null;
  private message = "";
  private raiseTo = 0;

  private el: {
    felt: HTMLElement; upper: HTMLElement; board: HTMLElement; pot: HTMLElement; myBet: HTMLElement;
    me: HTMLElement; log: HTMLElement; live: HTMLElement; controls: HTMLElement; handNo: HTMLElement;
    mute: HTMLButtonElement; menuBtn: HTMLButtonElement; menu: HTMLDialogElement;
  };

  constructor(root: HTMLElement, private roster: Opponent[]) {
    this.saved = load();
    setMuted(this.saved.muted);

    this.local = new LocalDriver(() => {
      this.raiseTo = this.local.waitingFor?.minRaiseTo ?? 0;
      sfx.turn();
      this.render();
    });

    root.innerHTML = `
      <header class="topbar">
        <h1 class="title">Pocket Pixels</h1>
        <span class="hand-no"></span>
        <button class="icon-btn" data-ui="mute"></button>
        <button class="icon-btn" data-ui="menu" aria-label="Menu and stats" aria-haspopup="dialog">${icon(ICONS.menu)}</button>
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
      <footer class="controls" aria-label="Your actions"></footer>
      <dialog class="menu" aria-labelledby="menu-title"></dialog>`;
    const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
    this.el = {
      felt: q(".felt"), upper: q(".upper"), board: q(".board"), pot: q(".pot"), myBet: q(".my-bet"), me: q(".me"),
      log: q(".log"), live: q('[role="status"]'), controls: q(".controls"), handNo: q(".hand-no"),
      mute: q('[data-ui="mute"]'), menuBtn: q('[data-ui="menu"]'), menu: q("dialog"),
    };
    paintTable(this.el.felt);
    // Seat positions depend on the table's height: redraw when it changes.
    let lastHeight = 0;
    new ResizeObserver(() => {
      const h = this.el.upper.clientHeight;
      if (h !== lastHeight && this.state) {
        lastHeight = h;
        this.render();
      }
    }).observe(this.el.upper);

    // Browsers only start audio after a tap.
    for (const type of ["pointerdown", "keydown"] as const) document.addEventListener(type, unlockAudio);
    this.el.mute.onclick = () => this.toggleMute();
    this.el.menuBtn.onclick = () => this.openMenu();
    this.renderMute();

    this.setupTable(this.saved.players, this.saved.chips);
    this.render();
  }

  start(): void {
    if (this.state.seats[HUMAN]!.stack > 0) void this.playHand();
  }

  /** Seat a fresh table of `players` (you plus bots), keeping your chips. */
  private setupTable(players: number, myChips: number): void {
    const names = TABLE_PICKS[players] ?? TABLE_PICKS[5]!;
    const opponents = this.roster.filter((o) => names.includes(o.name));
    this.state = createGame({
      players: [{ name: "You", personality: "human" }, ...opponents],
      stack: START_STACK,
      seed: randomSeed(),
    });
    this.state.seats[HUMAN]!.stack = myChips;
    const n = this.state.seats.length;
    this.avatars = ["you", ...opponents.map((o) => o.avatar)];
    this.slots = OPPONENT_SLOTS[opponents.length] ?? OPPONENT_SLOTS[4]!;
    this.bets = new Array<number>(n).fill(0);
    this.drawnBets = [...this.bets];
    this.drivers = [
      this.local,
      ...opponents.map((o) => new BotDriver(STYLES[o.personality], this.rng, () => 450 + this.rng.int(450))),
    ];
  }

  // ---------------------------------------------------------------- saving

  private persist(): void {
    this.saved.chips = this.state.seats[HUMAN]!.stack;
    this.saved.muted = isMuted();
    save(this.saved);
  }

  private recordHand(): void {
    const h = this.state.hand!;
    const r = h.result!;
    const me = this.state.seats[HUMAN]!;
    if (!me.hole.length) return;
    const st = this.saved.stats;
    st.handsPlayed++;
    const won = r.won[HUMAN] ?? 0;
    if (won > 0) {
      st.handsWon++;
      st.biggestPot = Math.max(st.biggestPot, won);
    }
    if (me.status !== "folded" && h.board.length === 5) {
      const hand = evaluateHand([...me.hole, ...h.board]);
      if (!st.bestHand || hand.score > st.bestHand.score) {
        st.bestHand = { score: hand.score, name: hand.name, cards: hand.cards.map(cardCode) };
      }
    }
  }

  // ---------------------------------------------------------------- hand loop

  private async playHand(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.pendingSize !== null) {
      this.setupTable(this.pendingSize, this.state.seats[HUMAN]!.stack);
      this.pendingSize = null;
    }
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
      this.persist();
      await this.show(step.events);
    }
    this.running = false;
    this.render();
  }

  private async show(events: GameEvent[]): Promise<void> {
    const h = this.state.hand!;
    const name = (seat: number) => this.state.seats[seat]!.name;
    let streets = 0;
    let blindSound = false;
    for (const e of events) {
      switch (e.type) {
        case "handStart":
          this.bets.fill(0);
          this.drawnBets.fill(0);
          this.say(`Hand ${e.handNo}. ${e.dealer === HUMAN ? "You have" : `${name(e.dealer)} has`} the button.`);
          break;
        case "blind":
          this.bets[e.seat] = e.amount;
          if (!blindSound) sfx.chips();
          blindSound = true;
          break;
        case "deal": {
          const me = this.state.seats[HUMAN]!;
          this.persist();
          if (me.hole.length) this.say(`Your cards: ${cardList(me.hole)}.`);
          this.render();
          await this.dealAnimation(e.seats);
          break;
        }
        case "action":
          this.bets[e.seat] = e.amount;
          this.say(actionText(name(e.seat), e.seat === HUMAN, e.kind, e.amount, e.allIn));
          if (e.kind === "fold") sfx.fold();
          else if (e.kind === "check") sfx.check();
          else if (e.allIn) sfx.allIn();
          else sfx.chips();
          this.render();
          break;
        case "returned":
          this.bets[e.seat] = Math.max(0, this.bets[e.seat]! - e.amount);
          this.say(`${fmt(e.amount)} uncalled ${e.seat === HUMAN ? "comes back to you" : `goes back to ${name(e.seat)}`}.`);
          this.render();
          break;
        case "street": {
          await sleep(streets++ === 0 ? 300 : 900);
          await this.gatherBets();
          const before = this.shownBoard;
          this.shownBoard += e.cards.length;
          const label = e.street === "flop" ? "Flop" : e.street === "turn" ? "Turn" : "River";
          this.say(`${label}: ${cardList(e.cards)}.`);
          this.render();
          await this.flipBoard(before, this.shownBoard);
          break;
        }
        case "handEnd":
          await sleep(250);
          this.pendingWin = [...e.result.won];
          await this.gatherBets();
          this.shownBoard = h.board.length;
          this.recordHand();
          this.persist();
          this.say(resultText(this.state));
          this.render();
          if (e.result.showdown) await this.flipShowdown();
          await sleep(e.result.showdown ? 1000 : 450);
          if ((e.result.won[HUMAN] ?? 0) > 0) sfx.win();
          else sfx.potSlide();
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

  // ---------------------------------------------------------------- card animation

  /** Deal hole cards from the middle of the table, one at a time around the table. */
  private async dealAnimation(seats: number[]): Promise<void> {
    if (reducedMotion()) return;
    const order: HTMLElement[] = [];
    for (const round of [0, 1]) {
      for (const seat of seats) {
        const card = this.seatNode(seat)?.querySelectorAll<HTMLElement>(".seat-cards .card")[round];
        if (card) order.push(card);
      }
    }
    const step = 70;
    order.forEach((_, i) => sfx.deal(i * step / 1000));
    await Promise.all(order.map((card, i) => slide(card, this.el.board, card, { duration: 220, delay: i * step, fade: "in" })));
  }

  private async flipBoard(from: number, to: number): Promise<void> {
    if (reducedMotion()) return;
    const cards = [...this.el.board.querySelectorAll<HTMLElement>(".card")].slice(from, to);
    cards.forEach((_, i) => sfx.flip(i * 0.11));
    await Promise.all(cards.map((c, i) => flipIn(c, i * 110)));
  }

  private async flipShowdown(): Promise<void> {
    if (reducedMotion()) return;
    const cards = [...this.el.upper.querySelectorAll<HTMLElement>(".seat-cards .card:not(.card--back)")];
    if (!cards.length) return;
    sfx.flip();
    await Promise.all(cards.map((c, i) => flipIn(c, Math.floor(i / 2) * 120)));
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
      sfx.chips();
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

  // ---------------------------------------------------------------- sound + menu

  private toggleMute(): void {
    setMuted(!isMuted());
    if (!isMuted()) {
      unlockAudio();
      sfx.chips();
    }
    this.persist();
    this.renderMute();
    if (this.el.menu.open) this.renderMenu();
  }

  private renderMute(): void {
    const off = isMuted();
    this.el.mute.innerHTML = icon(off ? ICONS.soundOff : ICONS.soundOn);
    this.el.mute.setAttribute("aria-label", "Sound");
    this.el.mute.setAttribute("aria-pressed", String(!off));
    this.el.mute.title = off ? "Sound is off" : "Sound is on";
  }

  private openMenu(): void {
    this.renderMenu();
    this.el.menu.showModal();
  }

  private renderMenu(confirmReset = false): void {
    const st = this.saved.stats;
    const seatsNow = this.pendingSize ?? this.state.seats.length;
    const best = st.bestHand;
    const m = this.el.menu;
    m.innerHTML = `
      <h2 id="menu-title" class="menu-title">Menu</h2>
      <section class="menu-section">
        <h3>Sound</h3>
        <button class="btn btn--small toggle" data-m="sound" aria-pressed="${!isMuted()}">${isMuted() ? "Off" : "On"}</button>
      </section>
      <section class="menu-section">
        <h3 id="size-label">Players at the table</h3>
        <div class="seg" role="radiogroup" aria-labelledby="size-label">
          ${[2, 3, 4, 5].map((n) => `<button class="btn btn--small" role="radio" aria-checked="${n === seatsNow}" data-m="size" data-n="${n}">${n}</button>`).join("")}
        </div>
        <p class="menu-note">${this.running && this.pendingSize !== null ? "Changes when this hand ends." : "You plus computer opponents."}</p>
      </section>
      <section class="menu-section">
        <h3>Your stats</h3>
        <dl class="stats">
          <dt>Chips</dt><dd>${fmt(this.state.seats[HUMAN]!.stack)}</dd>
          <dt>Hands played</dt><dd>${fmt(st.handsPlayed)}</dd>
          <dt>Hands won</dt><dd>${fmt(st.handsWon)}</dd>
          <dt>Biggest pot</dt><dd>${fmt(st.biggestPot)}</dd>
          <dt>Rebuys</dt><dd>${fmt(st.rebuys)}</dd>
          <dt>Best hand</dt><dd>${best ? best.name : "None yet"}</dd>
        </dl>
        <div class="best-cards" role="group" aria-label="${best ? `Best hand cards: ${cardList(best.cards.map(parseCard))}` : ""}"></div>
      </section>
      <div class="menu-actions">
        <button class="btn btn--small" data-m="reset">${confirmReset ? "Tap again to reset" : "Reset stats"}</button>
        <button class="btn btn--small btn--go" data-m="close">Close</button>
      </div>
      <p class="menu-note">Play chips only. No real money.</p>`;
    if (best) m.querySelector(".best-cards")!.append(...best.cards.map((c) => cardEl(parseCard(c), "sm")));
    m.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((b) => {
      b.onclick = () => {
        switch (b.dataset.m) {
          case "sound": this.toggleMute(); break;
          case "size": this.changeSize(Number(b.dataset.n)); break;
          case "reset":
            if (!confirmReset) return this.renderMenu(true);
            this.saved.stats = emptyStats();
            this.persist();
            this.renderMenu();
            break;
          case "close": m.close(); break;
        }
      };
    });
  }

  private changeSize(n: number): void {
    if (n === (this.pendingSize ?? this.state.seats.length)) return;
    this.saved.players = n;
    this.persist();
    if (this.running) this.pendingSize = n;
    else {
      this.pendingSize = null;
      this.setupTable(n, this.state.seats[HUMAN]!.stack);
      this.message = "";
      this.render();
    }
    this.renderMenu();
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
    // Slot heights are designed for a 196px top area; squeeze them on short screens.
    const k = Math.min(1, (this.el.upper.clientHeight || 196) / 196);
    for (const p of s.seats) {
      const seatEl = this.seatEl(p, winners.has(p.id), mark);
      const betEl = this.betEl(p.id);
      if (p.id === HUMAN) {
        this.el.me.replaceChildren(seatEl);
        this.el.myBet.replaceChildren(...(betEl ? [betEl] : []));
      } else {
        const slot = this.slots[p.id - 1]!;
        seatEl.style.left = `${slot.x}%`;
        seatEl.style.top = `${Math.round(slot.y * k)}px`;
        upper.push(seatEl);
        if (betEl) {
          betEl.classList.add("bet--placed");
          betEl.style.left = `${slot.bx}%`;
          betEl.style.top = `${Math.round(slot.by * k)}px`;
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

    const key = this.avatars[p.id] ?? "you";
    const avatar = `<div class="avatar" style="--c:${avatarBg(key)}" aria-hidden="true">${avatarSVG(key)}</div>`;
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
      ? `<div class="seat-cards"></div><div class="seat-side"><div class="seat-id">${avatar}${info}</div></div>${extras}`
      : `<div class="seat-top">${avatar}<div class="seat-cards"></div></div>${info}${extras}`;

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
          this.saved.stats.rebuys++;
          this.persist();
          sfx.chips();
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
