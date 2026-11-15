// Pixel-art cards. Classic two colors (spades and clubs black, hearts and
// diamonds red), and each suit has its own pixel shape, so suits never depend
// on color alone.

import { type Card, type Suit, cardLabel, rankFace } from "../engine/cards";
import { pixelSVG } from "./pixels";

// 9 x 9 suit shapes, drawn for this project.
const SUIT_SHAPES: Record<Suit, string[]> = {
  s: [
    "....X....",
    "...XXX...",
    "..XXXXX..",
    ".XXXXXXX.",
    "XXXXXXXXX",
    "XXXXXXXXX",
    ".XX.X.XX.",
    "....X....",
    "...XXX...",
  ],
  h: [
    ".........",
    ".XX...XX.",
    "XXXX.XXXX",
    "XXXXXXXXX",
    "XXXXXXXXX",
    ".XXXXXXX.",
    "..XXXXX..",
    "...XXX...",
    "....X....",
  ],
  d: [
    "....X....",
    "...XXX...",
    "..XXXXX..",
    ".XXXXXXX.",
    "XXXXXXXXX",
    ".XXXXXXX.",
    "..XXXXX..",
    "...XXX...",
    "....X....",
  ],
  c: [
    "...XXX...",
    "..XXXXX..",
    "..XXXXX..",
    "XXX.X.XXX",
    "XXXXXXXXX",
    "XXX.X.XXX",
    "....X....",
    "...XXX...",
    ".........",
  ],
};

export const SUIT_COLORS: Record<Suit, string> = {
  s: "#1a1a2e",
  h: "#d62839",
  d: "#d62839",
  c: "#1a1a2e",
};

export function suitSVG(suit: Suit, scale: number, className = ""): string {
  return pixelSVG(SUIT_SHAPES[suit], { X: SUIT_COLORS[suit] }, scale, className);
}

export type CardSize = "sm" | "md" | "lg";

const PIP_SCALE: Record<CardSize, [corner: number, pip: number]> = {
  sm: [2, 0],
  md: [2, 3],
  lg: [2, 4],
};

export function cardEl(card: Card, size: CardSize, extraClass = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `card card--${size} suit-${card.suit} ${extraClass}`.trim();
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", cardLabel(card));
  const [corner, pip] = PIP_SCALE[size];
  el.innerHTML =
    `<span class="card-corner" aria-hidden="true"><span class="card-rank">${rankFace(card.rank)}</span>` +
    `${suitSVG(card.suit, corner, "card-suit")}</span>` +
    (pip ? suitSVG(card.suit, pip, "card-pip") : "");
  return el;
}

export function cardBackEl(size: CardSize): HTMLElement {
  const el = document.createElement("div");
  el.className = `card card--${size} card--back`;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "face-down card");
  return el;
}

export function emptySlotEl(size: CardSize): HTMLElement {
  const el = document.createElement("div");
  el.className = `card-slot card--${size}`;
  el.setAttribute("aria-hidden", "true");
  return el;
}

export function cardList(cards: readonly Card[]): string {
  return cards.map(cardLabel).join(", ");
}
