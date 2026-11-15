// Card elements. Each suit has its own shape and its own color (four-color
// deck), so suits never depend on color alone.

import { type Card, type Suit, cardLabel, rankFace } from "../engine/cards";

// U+FE0E asks for the plain text glyph instead of an emoji.
const SUIT_GLYPHS: Record<Suit, string> = { s: "♠︎", h: "♥︎", d: "♦︎", c: "♣︎" };

export type CardSize = "sm" | "md" | "lg";

export function cardEl(card: Card, size: CardSize, extraClass = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `card card--${size} suit-${card.suit} ${extraClass}`.trim();
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", cardLabel(card));
  el.innerHTML =
    `<span class="card-rank" aria-hidden="true">${rankFace(card.rank)}</span>` +
    `<span class="card-suit" aria-hidden="true">${SUIT_GLYPHS[card.suit]}</span>`;
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
  el.className = `card card--${size} card--empty`;
  el.setAttribute("aria-hidden", "true");
  return el;
}

export function cardList(cards: readonly Card[]): string {
  return cards.map(cardLabel).join(", ");
}
