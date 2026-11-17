// Messages between a phone and the table server.

import { type Level, isLevel } from "../engine/brain";
import type { Action, GameEvent } from "../engine/game";
import type { TableView } from "../engine/view";

export const MAX_SEATS = 5;
export const START_CHIPS = 1000;
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;

export type ClientMsg =
  | { t: "join"; name: string; token?: string; avatar?: string }
  | { t: "profile"; name: string; avatar?: string }
  | { t: "pause"; paused: boolean }
  | { t: "level"; level: Level }
  | { t: "act"; action: Action }
  | { t: "start" }
  | { t: "addBot" }
  /** Host only: remove a bot or a person from a seat (removeBot is the older name). */
  | { t: "kick"; seat: number }
  | { t: "removeBot"; seat: number }
  | { t: "rebuy" }
  /** Take a break: keep your seat and chips but skip hands until "back". */
  | { t: "sitOut" }
  | { t: "back" }
  | { t: "leave" };

export interface RoomSeatView {
  kind: "human" | "bot" | "open";
  name: string;
  avatar: string;
  connected: boolean;
  away: boolean;
  host: boolean;
  /** Leaves (or was removed) and goes when the current hand ends. */
  leaving?: boolean;
}

export interface RoomView {
  code: string;
  seats: RoomSeatView[];
  started: boolean;
  /** The host paused the game: nobody acts and no timers run. */
  paused: boolean;
  /** How well the bots play. */
  level: Level;
  /** Milliseconds left for the player whose turn it is, when a person is acting. */
  turnMsLeft: number | null;
  turnMs: number;
}

export type ServerMsg =
  | { t: "welcome"; seat: number; token: string }
  | { t: "update"; view: TableView; events: GameEvent[]; room: RoomView }
  | { t: "error"; message: string }
  /** You are no longer seated: you left, opened the table elsewhere, or the host removed you. */
  | { t: "left"; reason?: "kicked" };

export function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

export function randomCode(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

/** Letters, digits and single spaces, at most 12 characters. */
export function cleanName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 12) : "";
  return s || "Player";
}

/** Avatar keys look like "astronaut-2"; the screen falls back for unknown ones. */
export function cleanAvatar(raw: unknown): string | undefined {
  return typeof raw === "string" && /^[a-z0-9-]{1,24}$/.test(raw) ? raw : undefined;
}

/** Parse and check a message from a phone; anything odd becomes null. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case "join":
      return {
        t: "join",
        name: cleanName(o.name),
        token: typeof o.token === "string" && o.token.length <= 64 ? o.token : undefined,
        avatar: cleanAvatar(o.avatar),
      };
    case "profile":
      return { t: "profile", name: cleanName(o.name), avatar: cleanAvatar(o.avatar) };
    case "pause":
      return typeof o.paused === "boolean" ? { t: "pause", paused: o.paused } : null;
    case "level":
      return isLevel(o.level) ? { t: "level", level: o.level } : null;
    case "act": {
      const a = o.action as Record<string, unknown> | undefined;
      if (!a || typeof a !== "object") return null;
      if (a.type === "fold" || a.type === "check" || a.type === "call") return { t: "act", action: { type: a.type } };
      if (a.type === "raise" && typeof a.to === "number" && Number.isFinite(a.to)) return { t: "act", action: { type: "raise", to: Math.floor(a.to) } };
      return null;
    }
    case "removeBot": case "kick":
      return typeof o.seat === "number" && Number.isInteger(o.seat) ? { t: o.t, seat: o.seat } : null;
    case "start": case "addBot": case "rebuy": case "sitOut": case "back": case "leave":
      return { t: o.t };
    default:
      return null;
  }
}
