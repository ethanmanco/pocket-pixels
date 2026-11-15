// The table screen. It draws whatever its source sends (solo play on this
// phone, or a table on the server), animates cards and chips, plays sounds,
// keeps your stats, and passes your moves back to the source.
//
// Layout, top to bottom: opponents along the top arc (with their bets below
// them), the board and pot in the middle, your bet, then you. You are always
// seat 0 on screen.

import { type Card, cardCode, parseCard, rankName, sameCard } from "../engine/cards";
import { evaluateHand } from "../engine/evaluate";
import type { Action, GameEvent, HandResult, LegalActions } from "../engine/game";
import { type SeatView, type TableView, viewBetweenHands } from "../engine/view";
import { type RoomView, isValidCode, randomCode } from "../online/protocol";
import { avatarBg, avatarSVG } from "./avatars";
import { cardBackEl, cardEl, cardList, emptySlotEl } from "./cards";
import { chipsSVG, pileColumns, stackColumn } from "./chips";
import { flipIn, slide } from "./motion";
import { pixelSVG } from "./pixels";
import { isMuted, setMuted, sfx, unlockAudio } from "./sfx";
import { LocalSource, OnlineSource, type Opponent, type TableSource, type Update } from "./source";
import { type Saved, START_STACK, defaults, emptyStats, load, save } from "./storage";
import { paintTable } from "./table";
import { devSeed, reducedMotion, sleep } from "./timing";

export type { Opponent } from "./source";

const HUMAN = 0;

export type Mode = { kind: "local"; roster: Opponent[] } | { kind: "online"; code: string };

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

const CHIP_SCALE = 3;

const ICONS = {
  soundOn: ["....X.....", "...XX..X..", "XXXXX...X.", "XXXXX.X.X.", "XXXXX.X.X.", "XXXXX...X.", "...XX..X..", "....X....."],
  soundOff: ["....X.....", "...XX.....", "XXXXX.X.X.", "XXXXX..X..", "XXXXX.X.X.", "XXXXX.....", "...XX.....", "....X....."],
  menu: ["XXXXXXXXX", "XXXXXXXXX", ".........", "XXXXXXXXX", "XXXXXXXXX", ".........", "XXXXXXXXX", "XXXXXXXXX"],
};
const icon = (rows: string[]) => pixelSVG(rows, { X: "currentColor" }, 3, "icon");

const fmt = (n: number) => n.toLocaleString("en-US");
const round5 = (n: number) => Math.round(n / 5) * 5;
/** Names from the server are already letters, digits and spaces; escape anyway. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const homeUrl = () => `${location.origin}${location.pathname}`;

function emptyView(): TableView {
  return { me: 0, seats: [], hand: null, smallBlind: 5, bigBlind: 10, legal: null };
}

export class TableApp {
  private source: TableSource | null = null;
  private view: TableView = emptyView();
  private room: RoomView | null = null;
  private avatars: string[] = [];
  private saved: Saved;
  private queue: { u: Update; done: () => void }[] = [];
  private draining = false;
  private animating = false;
  private joined = false;

  /** Board cards shown so far (all-in runouts reveal one street at a time). */
  private shownBoard = 0;
  /** Chips shown in front of each player this street (lags the engine while chips animate). */
  private bets: number[] = [];
  private drawnBets: number[] = [];
  /** Winnings not yet slid over to the winners' stacks. */
  private pendingWin: number[] | null = null;
  private message = "";
  private raiseTo = 0;
  private turnKey = "";
  private turnDeadline: number | null = null;
  private sentAction = false;
  /** Hold showdown cards face down until the hand-end moment in the animation. */
  private holdReveal = false;

  private el: {
    felt: HTMLElement; upper: HTMLElement; board: HTMLElement; pot: HTMLElement; myBet: HTMLElement;
    me: HTMLElement; log: HTMLElement; live: HTMLElement; controls: HTMLElement; handNo: HTMLElement;
    mute: HTMLButtonElement; menuBtn: HTMLButtonElement; menu: HTMLDialogElement;
  };

  constructor(root: HTMLElement, private mode: Mode) {
    // A demo seed starts from a clean slate so the hand plays out the same way.
    this.saved = devSeed() === null ? load() : defaults();
    setMuted(this.saved.muted);

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
      if (h !== lastHeight) {
        lastHeight = h;
        this.render();
      }
    }).observe(this.el.upper);

    // Browsers only start audio after a tap.
    for (const type of ["pointerdown", "keydown"] as const) document.addEventListener(type, unlockAudio);
    this.el.mute.onclick = () => this.toggleMute();
    this.el.menuBtn.onclick = () => this.openMenu();
    this.renderMute();
    // The turn timer counts down on screen.
    setInterval(() => {
      if (this.turnDeadline !== null && !document.hidden) this.renderTimer();
    }, 500);
    this.render();
  }

  start(): void {
    if (this.mode.kind === "local") {
      this.source = new LocalSource(this.mode.roster, this.saved, () => this.persist());
      this.source.start((u) => this.enqueue(u));
    } else if (!this.saved.name) {
      this.askName();
    } else {
      this.connect();
    }
  }

  private get local(): LocalSource | null {
    return this.source instanceof LocalSource ? this.source : null;
  }

  private get online(): OnlineSource | null {
    return this.source instanceof OnlineSource ? this.source : null;
  }

  private connect(): void {
    if (this.mode.kind !== "online") return;
    const src = new OnlineSource(this.mode.code, this.saved.name, {
      status: (text) => {
        this.say(text);
        this.render();
      },
      left: () => {
        location.href = homeUrl();
      },
    });
    this.source = src;
    src.start((u) => this.enqueue(u));
  }

  // ---------------------------------------------------------------- saving

  private persist(): void {
    this.saved.muted = isMuted();
    save(this.saved);
  }

  private recordHand(result: HandResult): void {
    const me = this.view.seats[HUMAN];
    const h = this.view.hand;
    if (!me || !me.cardCount || !h) return;
    const st = this.saved.stats;
    st.handsPlayed++;
    const won = result.won[HUMAN] ?? 0;
    if (won > 0) {
      st.handsWon++;
      st.biggestPot = Math.max(st.biggestPot, won);
    }
    if (me.status !== "folded" && me.hole.length === 2 && h.board.length === 5) {
      const hand = evaluateHand([...me.hole, ...h.board]);
      if (!st.bestHand || hand.score > st.bestHand.score) {
        st.bestHand = { score: hand.score, name: hand.name, cards: hand.cards.map(cardCode) };
      }
    }
    this.persist();
  }

  // ---------------------------------------------------------------- updates

  /** Updates are shown one at a time, in order; solo play waits for each. */
  private enqueue(u: Update): Promise<void> {
    return new Promise((done) => {
      this.queue.push({ u, done });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length) {
      const { u, done } = this.queue.shift()!;
      // Catching up (the phone was asleep): skip the animations.
      const fast = this.queue.length > 2 || document.hidden;
      await this.apply(u, fast);
      done();
    }
    this.draining = false;
  }

  private async apply(u: Update, fast: boolean): Promise<void> {
    const before = this.view.seats.length;
    this.view = u.view;
    this.avatars = u.avatars;
    this.room = u.room;
    this.joined = true;
    this.sentAction = false;
    const n = u.view.seats.length;
    if (n !== before) {
      this.bets = new Array<number>(n).fill(0);
      this.drawnBets = [...this.bets];
    }
    this.turnDeadline = u.room?.turnMsLeft != null ? Date.now() + u.room.turnMsLeft : null;

    if (fast) {
      for (const e of u.events) if (e.type === "handEnd") this.recordHand(e.result);
      this.pendingWin = null;
    } else {
      this.animating = true;
      this.holdReveal = u.events.some((e) => e.type === "handEnd");
      await this.show(u.events);
      this.holdReveal = false;
      this.animating = false;
    }
    // Settle the display on the final state of this update.
    this.bets = this.view.seats.map((s) => s.streetBet);
    this.drawnBets = [...this.bets];
    this.shownBoard = this.view.hand?.board.length ?? 0;

    const legal = this.view.legal;
    if (legal) {
      const h = this.view.hand!;
      const key = `${h.number}:${h.street}:${h.currentBet}`;
      if (key !== this.turnKey) {
        this.turnKey = key;
        this.raiseTo = legal.minRaiseTo;
        sfx.turn();
      }
    }
    this.render();
  }

  private async show(events: GameEvent[]): Promise<void> {
    const name = (seat: number) => (seat === HUMAN ? "You" : this.view.seats[seat]?.name ?? "");
    let streets = 0;
    let blindSound = false;
    for (const e of events) {
      switch (e.type) {
        case "handStart":
          this.bets.fill(0);
          this.drawnBets.fill(0);
          this.shownBoard = 0;
          this.pendingWin = null;
          this.say(`Hand ${e.handNo}. ${e.dealer === HUMAN ? "You have" : `${name(e.dealer)} has`} the button.`);
          break;
        case "blind":
          this.bets[e.seat] = e.amount;
          if (!blindSound) sfx.chips();
          blindSound = true;
          break;
        case "deal": {
          const me = this.view.seats[HUMAN];
          if (me?.hole.length) this.say(`Your cards: ${cardList(me.hole)}.`);
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
          this.bets[e.seat] = Math.max(0, (this.bets[e.seat] ?? 0) - e.amount);
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
          this.shownBoard = this.view.hand?.board.length ?? 0;
          this.recordHand(e.result);
          this.holdReveal = false;
          this.say(resultText(this.view, e.result));
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

  private act(action: Action): void {
    if (!this.view.legal || this.animating || this.sentAction) return;
    this.sentAction = true;
    this.source?.act(action);
    this.renderControls();
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
    order.forEach((_, i) => sfx.deal((i * step) / 1000));
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

  // ---------------------------------------------------------------- sound, name, menu

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

  /** Online: ask for a name before sitting down. */
  private askName(): void {
    const m = this.el.menu;
    m.innerHTML = `
      <form method="dialog" class="name-form">
        <h2 id="menu-title" class="menu-title">Join table ${this.mode.kind === "online" ? this.mode.code : ""}</h2>
        <label class="menu-section" for="name-input"><h3>Your name</h3></label>
        <input id="name-input" class="text-input" maxlength="12" autocomplete="nickname" value="${esc(this.saved.name)}" placeholder="Player">
        <p class="menu-note">Letters and numbers, up to 12. Other players see it.</p>
        <div class="menu-actions">
          <button type="button" class="btn btn--small" data-m="solo">Play solo</button>
          <button class="btn btn--small btn--go" data-m="sit">Sit down</button>
        </div>
      </form>`;
    const input = m.querySelector<HTMLInputElement>("input")!;
    m.querySelector<HTMLButtonElement>('[data-m="solo"]')!.onclick = () => (location.href = homeUrl());
    m.querySelector("form")!.onsubmit = (e) => {
      e.preventDefault();
      this.saved.name = input.value.replace(/[^A-Za-z0-9 ]/g, "").trim().slice(0, 12) || "Player";
      this.persist();
      m.close();
      this.connect();
    };
    m.showModal();
    input.focus();
  }

  private openMenu(): void {
    this.renderMenu();
    if (!this.el.menu.open) this.el.menu.showModal();
  }

  private inviteLink(): string {
    return this.mode.kind === "online" ? `${homeUrl()}?table=${this.mode.code}` : homeUrl();
  }

  private async invite(): Promise<void> {
    const url = this.inviteLink();
    try {
      if (navigator.share) {
        await navigator.share({ title: "Pocket Pixels", text: "Join my poker table (play chips only).", url });
        return;
      }
    } catch {
      // Share sheet closed; fall back to copying.
    }
    try {
      await navigator.clipboard.writeText(url);
      this.say("Invite link copied. Send it to a friend.");
    } catch {
      this.say(`Invite link: ${url}`);
    }
    this.render();
  }

  private renderMenu(confirmReset = false): void {
    const st = this.saved.stats;
    const best = st.bestHand;
    const m = this.el.menu;
    const local = this.local;
    const online = this.online;
    const me = this.view.seats[HUMAN];
    const host = !!this.room?.seats[HUMAN]?.host;

    const friends = online
      ? `
      <section class="menu-section">
        <h3>Table ${online.code}</h3>
        <div class="menu-actions menu-actions--flat">
          <button class="btn btn--small" data-m="invite">Invite friends</button>
          <button class="btn btn--small btn--fold" data-m="leave">Leave table</button>
        </div>
        ${host ? `
        <ul class="seat-list">
          ${(this.room?.seats ?? []).map((s, i) => i === HUMAN ? "" : `<li>
            <span>${s.kind === "open" ? "Open seat" : esc(s.name)}${s.kind === "bot" ? " (bot)" : ""}${s.kind === "human" && (s.away || !s.connected) ? " (away)" : ""}</span>
            ${s.kind === "bot" ? `<button class="btn btn--small btn--mini" data-m="remove" data-seat="${i}">Remove</button>` : ""}
          </li>`).join("")}
        </ul>
        <button class="btn btn--small" data-m="addbot">Add a bot</button>
        <p class="menu-note">You are the host: you can add or remove bots.</p>` : ""}
      </section>`
      : `
      <section class="menu-section">
        <h3>Play with friends</h3>
        <div class="menu-actions menu-actions--flat">
          <button class="btn btn--small btn--go" data-m="create">New table</button>
        </div>
        <form class="join-form" data-m="join">
          <input class="text-input" name="code" maxlength="5" autocapitalize="characters" autocomplete="off" placeholder="CODE" aria-label="Table code">
          <button class="btn btn--small">Join</button>
        </form>
        <p class="menu-note">Make a table and send the link, or type a friend's code.</p>
      </section>`;

    m.innerHTML = `
      <h2 id="menu-title" class="menu-title">Menu</h2>
      <section class="menu-section">
        <h3>Sound</h3>
        <button class="btn btn--small toggle" data-m="sound" aria-pressed="${!isMuted()}">${isMuted() ? "Off" : "On"}</button>
      </section>
      ${friends}
      ${local ? `
      <section class="menu-section">
        <h3 id="size-label">Players at the table</h3>
        <div class="seg" role="radiogroup" aria-labelledby="size-label">
          ${[2, 3, 4, 5].map((n) => `<button class="btn btn--small" role="radio" aria-checked="${n === local.seats}" data-m="size" data-n="${n}">${n}</button>`).join("")}
        </div>
        <p class="menu-note">${local.busy ? "Changes when this hand ends." : "You plus computer opponents."}</p>
      </section>` : ""}
      <section class="menu-section">
        <h3>Your stats</h3>
        <dl class="stats">
          ${local && me ? `<dt>Chips</dt><dd>${fmt(me.stack)}</dd>` : ""}
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

    m.querySelector<HTMLFormElement>('form[data-m="join"]')?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = (e.target as HTMLFormElement).querySelector("input")!;
      const code = input.value.trim().toUpperCase();
      if (isValidCode(code)) location.href = `${homeUrl()}?table=${code}`;
      else {
        input.setCustomValidity("Codes are 5 letters and numbers.");
        input.reportValidity();
      }
    });
    m.querySelectorAll<HTMLButtonElement>("button[data-m]").forEach((b) => {
      b.onclick = () => {
        switch (b.dataset.m) {
          case "sound": this.toggleMute(); break;
          case "size":
            this.saved.players = Number(b.dataset.n);
            this.persist();
            local?.setSize(this.saved.players);
            this.renderMenu();
            break;
          case "create": location.href = `${homeUrl()}?table=${randomCode()}`; break;
          case "invite": void this.invite(); break;
          case "leave":
            online?.leave();
            setTimeout(() => (location.href = homeUrl()), 400);
            break;
          case "addbot": online?.addBot(); break;
          case "remove": online?.removeBot(Number(b.dataset.seat)); break;
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

  // ---------------------------------------------------------------- drawing

  private render(): void {
    const v = this.view;
    const h = v.hand;
    this.el.handNo.textContent = this.online ? `Table ${this.online.code}` : h ? `Hand ${h.number}` : "";
    this.el.log.textContent = this.message;

    const result = h?.result ?? null;
    const winners = new Set<number>();
    if (result && this.pendingWin !== null) for (const pot of result.pots) pot.winners.forEach((w) => winners.add(w));
    const winCards = result?.pots[0]?.hand?.cards ?? [];
    const showdown = !!result?.showdown && !this.holdReveal;
    const mark = (c: Card) => (showdown ? (winCards.some((w) => sameCard(w, c)) ? "is-win" : "is-dim") : "");

    // Seats and bets
    const slots = OPPONENT_SLOTS[Math.max(1, v.seats.length - 1)] ?? OPPONENT_SLOTS[4]!;
    // Slot heights are designed for a 196px top area; squeeze them on short screens.
    const k = Math.min(1, (this.el.upper.clientHeight || 196) / 196);
    const upper: HTMLElement[] = [];
    const newBets: [HTMLElement, number][] = [];
    this.el.me.replaceChildren();
    this.el.myBet.replaceChildren();
    for (const p of v.seats) {
      const seatEl = this.seatEl(p, winners.has(p.id), mark);
      const betEl = this.betEl(p.id);
      if (p.id === HUMAN) {
        this.el.me.replaceChildren(seatEl);
        if (betEl) this.el.myBet.replaceChildren(betEl);
      } else {
        const slot = slots[p.id - 1]!;
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
      if (betEl && (this.bets[p.id] ?? 0) > (this.drawnBets[p.id] ?? 0)) newBets.push([betEl, p.id]);
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
    const cards: HTMLElement[] = [];
    for (let i = 0; i < 5; i++) {
      const c = board[i];
      cards.push(c ? cardEl(c, "md", mark(c)) : emptySlotEl("md"));
    }
    this.el.board.replaceChildren(...cards);
    this.el.board.setAttribute("aria-label", board.length ? `Board: ${cardList(board)}` : "Board: no cards yet");

    // Pot: chips gathered in the middle (bets still in front of players are not in it yet).
    const committed = v.seats.reduce((sum, p) => sum + p.committed, 0);
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
    const amount = this.bets[seat] ?? 0;
    if (amount <= 0) return null;
    const el = document.createElement("div");
    el.className = "bet";
    el.dataset.seat = String(seat);
    el.innerHTML = `${chipsSVG([stackColumn(amount, 4)], CHIP_SCALE)}<span class="bet-amount">${fmt(amount)}</span>`;
    return el;
  }

  private seatEl(p: SeatView, winner: boolean, mark: (c: Card) => string): HTMLElement {
    const h = this.view.hand;
    const isMe = p.id === HUMAN;
    const roomSeat = this.room?.seats[p.id];
    const el = document.createElement("div");
    el.dataset.seat = String(p.id);

    if (roomSeat?.kind === "open" && !isMe) {
      el.className = "seat seat--opp seat--open";
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", "Open seat");
      el.innerHTML = `<div class="seat-top"><div class="avatar avatar--open" aria-hidden="true"></div></div><div class="seat-info" aria-hidden="true"><span class="name">Open</span></div>`;
      return el;
    }

    const running = !!h && h.street !== "complete";
    const toAct = running && h!.toAct === p.id;
    const away = roomSeat?.kind === "human" && (roomSeat.away || !roomSeat.connected);
    el.className = [
      "seat", isMe ? "seat--me" : "seat--opp", toAct ? "is-turn" : "", p.status === "folded" ? "is-folded" : "",
      p.status === "out" || away ? "is-out" : "", winner ? "is-winner" : "",
    ].filter(Boolean).join(" ");

    const stack = p.stack - (this.pendingWin?.[p.id] ?? 0);
    const tag = away ? "Away" : p.status === "allin" ? "All in" : p.status === "folded" ? "Fold"
      : p.lastAction ? tagText(p.lastAction.kind) : "";
    const thinking = toAct && !isMe && !this.animating;
    const name = isMe ? "You" : p.name;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", [
      name,
      `${fmt(stack)} chips`,
      roomSeat?.host ? "host" : "",
      h?.dealer === p.id ? "dealer button" : "",
      this.bets[p.id] ? `bet ${fmt(this.bets[p.id]!)}` : "",
      tag && !isMe ? tag.toLowerCase() : "",
      thinking ? "thinking" : "",
    ].filter(Boolean).join(", "));

    const key = this.avatars[p.id] ?? "you";
    const avatar = `<div class="avatar" style="--c:${avatarBg(key)}" aria-hidden="true">${avatarSVG(key)}</div>`;
    const timer = toAct && this.turnDeadline !== null ? '<span class="timer" aria-hidden="true"><i></i></span>' : "";
    const extras = `
      ${h?.dealer === p.id ? '<span class="dealer" aria-hidden="true">D</span>' : ""}
      ${tag && !isMe ? `<span class="tag" aria-hidden="true">${tag}</span>` : ""}
      ${thinking ? '<span class="thinking" aria-hidden="true"><i></i><i></i><i></i></span>' : ""}
      ${timer}`;
    const info = `
      <div class="seat-info" aria-hidden="true">
        <span class="name">${esc(name)}</span>
        <span class="stack">${fmt(stack)}</span>
      </div>`;
    el.innerHTML = isMe
      ? `<div class="seat-cards"></div><div class="seat-side"><div class="seat-id">${avatar}${info}</div></div>${extras}`
      : `<div class="seat-top">${avatar}<div class="seat-cards"></div></div>${info}${extras}`;

    const cards = el.querySelector<HTMLElement>(".seat-cards")!;
    if (h && p.cardCount && p.status !== "folded") {
      if (isMe) {
        for (const c of p.hole) cards.append(cardEl(c, "lg", mark(c)));
        cards.setAttribute("aria-label", `Your cards: ${cardList(p.hole)}`);
      } else {
        const reveal = p.hole.length > 0 && !this.holdReveal;
        if (reveal) for (const c of p.hole) cards.append(cardEl(c, "sm", mark(c)));
        else for (let i = 0; i < p.cardCount; i++) cards.append(cardBackEl("sm"));
        cards.setAttribute("aria-label", reveal ? `${p.name}'s cards: ${cardList(p.hole)}` : `${p.name}'s cards, face down`);
        if (reveal) cards.classList.add("is-revealed");
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

  /** Shrink the turn timer bar to the time left. */
  private renderTimer(): void {
    const bar = this.el.felt.querySelector<HTMLElement>(".timer i");
    const total = this.room?.turnMs ?? 30_000;
    if (!bar || this.turnDeadline === null) return;
    const left = Math.max(0, this.turnDeadline - Date.now());
    bar.style.transform = `scaleX(${left / total})`;
    bar.classList.toggle("is-low", left < 8000);
    const note = this.el.controls.querySelector<HTMLElement>(".turn-left");
    if (note) note.textContent = `${Math.ceil(left / 1000)}s`;
  }

  private renderControls(): void {
    const v = this.view;
    const c = this.el.controls;
    const legal = this.animating || this.sentAction ? null : v.legal;
    const me = v.seats[HUMAN];
    const online = this.online;
    const room = this.room;

    const shell = (quick: string, note: string, row: string) => {
      c.innerHTML = `<div class="row row--quick">${quick}</div><p class="controls-note">${note}</p><div class="row">${row}</div>`;
    };
    const wire = () =>
      c.querySelectorAll<HTMLButtonElement>("button[data-do]").forEach((b) => {
        b.onclick = () => {
          switch (b.dataset.do) {
            case "next": void this.local?.next(); break;
            case "rebuy":
              this.saved.stats.rebuys++;
              this.persist();
              sfx.chips();
              this.source?.rebuy();
              this.say(`You rebuy for ${fmt(START_STACK)}.`);
              break;
            case "start": online?.startGame(); break;
            case "addbot": online?.addBot(); break;
            case "invite": void this.invite(); break;
            case "back": online?.back(); break;
            case "solo": location.href = homeUrl(); break;
          }
        };
      });
    const disabledRow = '<button class="btn" disabled>Fold</button><button class="btn" disabled>Check</button><button class="btn" disabled>Raise</button>';

    // Online, before the table has answered.
    if (online && !this.joined) {
      shell("", "", '<button class="btn btn--small" data-do="solo">Play solo instead</button>');
      return wire();
    }

    // Online lobby: the host adds bots and starts; everyone can invite.
    if (online && room && !room.started) {
      const seated = room.seats.filter((s) => s.kind !== "open").length;
      if (room.seats[HUMAN]?.host) {
        shell(
          `<button class="btn btn--small" data-do="invite">Invite</button><button class="btn btn--small" data-do="addbot">Add bot</button>`,
          seated < 2 ? "Invite a friend or add a bot." : `${seated} players seated.`,
          `<button class="btn btn--go" data-do="start" ${seated < 2 ? "disabled" : ""}>Start game</button>`,
        );
      } else {
        shell(`<button class="btn btn--small" data-do="invite">Invite</button>`, "Waiting for the host to start.", disabledRow);
      }
      return wire();
    }

    if (!legal) {
      const h = v.hand;
      const running = !!h && h.street !== "complete";
      const broke = !!me && me.stack === 0 && (!running || me.status === "out");
      if (!this.animating && broke && (online || !this.local?.busy)) {
        shell("", "You are out of chips.", `<button class="btn btn--go" data-do="rebuy">Rebuy ${fmt(START_STACK)}</button>`);
        return wire();
      }
      if (online && room?.seats[HUMAN]?.away) {
        shell("", "You are sitting out.", `<button class="btn btn--go" data-do="back">I'm back</button>`);
        return wire();
      }
      if (!online && !this.animating && !this.local?.busy && viewBetweenHands(v)) {
        shell("", "", `<button class="btn btn--go" data-do="next">${h ? "Next hand" : "Deal"}</button>`);
        return wire();
      }
      let note = "";
      if (running && h!.toAct !== null && h!.toAct !== HUMAN) note = `Waiting for ${esc(v.seats[h!.toAct]?.name ?? "")}`;
      else if (online && running && me?.status === "out") note = "You join in the next hand.";
      else if (online && !running) note = "Next hand starting soon.";
      shell("", note, disabledRow);
      return;
    }

    this.raiseTo = Math.min(Math.max(this.raiseTo, legal.minRaiseTo), legal.maxRaiseTo);
    const word = legal.isBet ? "Bet" : "Raise to";
    const raiseLabel = () => label(this.raiseTo === legal.maxRaiseTo ? "All in" : word, this.raiseTo);
    const callIsAllIn = legal.toCall === (me?.stack ?? 0);

    c.innerHTML = `
      <div class="row row--quick">${legal.canRaise ? `
        <button class="btn btn--small" data-preset="min">Min</button>
        <button class="btn btn--small" data-preset="half">1/2 pot</button>
        <button class="btn btn--small" data-preset="pot">Pot</button>
        <button class="btn btn--small" data-preset="all">All in</button>` : ""}
      </div>
      <div class="row row--slider">${legal.canRaise ? `
        <input type="range" class="slider" min="${legal.minRaiseTo}" max="${legal.maxRaiseTo}" step="1" value="${this.raiseTo}" aria-label="Raise amount">` : ""}
        ${online && this.turnDeadline !== null ? '<span class="turn-left" aria-hidden="true"></span>' : ""}
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
      const val = Number(slider.value);
      // Snap to multiples of 5, but keep both ends reachable.
      setTo(val >= legal.maxRaiseTo ? legal.maxRaiseTo : Math.max(legal.minRaiseTo, round5(val)));
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
    this.renderTimer();
  }

  private presetTo(kind: "min" | "half" | "pot" | "all", legal: LegalActions): number {
    const h = this.view.hand!;
    const pot = this.view.seats.reduce((s, p) => s + p.committed, 0);
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

function resultText(view: TableView, r: HandResult): string {
  const name = (seat: number) => (seat === HUMAN ? "You" : view.seats[seat]?.name ?? "");
  const verb = (seat: number) => (seat === HUMAN ? "win" : "wins");
  const first = r.pots[0];
  if (!first) return "";
  // One player took every pot: say it once, with the total.
  if (first.winners.length === 1 && r.pots.every((p) => p.winners.length === 1 && p.winners[0] === first.winners[0])) {
    const w = first.winners[0]!;
    const total = r.pots.reduce((s, p) => s + p.amount, 0);
    return `${name(w)} ${verb(w)} ${fmt(total)}${first.handText ? ` with ${lowerFirst(first.handText)}` : ""}.`;
  }
  return r.pots
    .map((pot, i) => {
      const tag = r.pots.length > 1 ? (i === 0 ? "Main pot: " : r.pots.length > 2 ? `Side pot ${i}: ` : "Side pot: ") : "";
      const how = pot.handText ? ` with ${lowerFirst(pot.handText)}` : "";
      if (pot.winners.length > 1) {
        // "You, Pebble and Bo": you first, commas, "and" before the last.
        const names = [...pot.winners].sort((a, b) => (a === HUMAN ? -1 : b === HUMAN ? 1 : 0)).map(name);
        const list = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
        return `${tag}Split. ${list} each win ${fmt(pot.shares[pot.winners.length - 1]!)}${how}.`;
      }
      const w = pot.winners[0]!;
      return `${tag}${name(w)} ${verb(w)} ${fmt(pot.amount)}${how}.`;
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
