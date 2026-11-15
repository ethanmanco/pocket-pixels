import { describe, expect, it } from "vitest";
import { cleanName, isValidCode, parseClientMsg, randomCode } from "../src/online/protocol";
import { AWAY_TURN_MS, EXPIRE_MS, Room, TURN_MS, newRoom } from "../src/online/room";

function setup() {
  let clock = 1_000_000;
  let n = 0;
  const room = new Room(newRoom("ABCDE", 42), () => clock, () => `tok${++n}`);
  return {
    room,
    advance(ms: number) {
      clock += ms;
    },
    /** Jump to the next pending moment and run it. */
    step() {
      const p = room.s.pending;
      if (!p) return false;
      clock = Math.max(clock, p.at);
      return room.tick();
    },
  };
}

const total = (room: Room) => room.s.game.seats.reduce((s, p) => s + p.stack + p.committed * (room.s.game.hand?.street === "complete" ? 0 : 1), 0);

describe("protocol", () => {
  it("makes and checks table codes", () => {
    const code = randomCode();
    expect(isValidCode(code)).toBe(true);
    expect(isValidCode("abcde")).toBe(false);
    expect(isValidCode("ABC0E")).toBe(false); // no zero: too easy to confuse with O
  });

  it("cleans names", () => {
    expect(cleanName("  Ethan  ")).toBe("Ethan");
    expect(cleanName("<img src=x onerror=alert(1)>")).toBe("img srcx one");
    expect(cleanName("")).toBe("Player");
    expect(cleanName(42)).toBe("Player");
  });

  it("rejects malformed messages", () => {
    expect(parseClientMsg("not json")).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "act", action: { type: "raise", to: "lots" } }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "hack" }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "act", action: { type: "raise", to: 40.7 } }))).toEqual({ t: "act", action: { type: "raise", to: 40 } });
  });
});

describe("room", () => {
  it("seats people, makes the first one host, and refuses a sixth", () => {
    const { room } = setup();
    const a = room.join(undefined, "Ann");
    const b = room.join(undefined, "Bo");
    expect(a).toEqual({ seat: 0, token: "tok1" });
    expect(b).toEqual({ seat: 1, token: "tok2" });
    expect(room.roomView().seats[0]!.host).toBe(true);
    room.join(undefined, "C");
    room.join(undefined, "D");
    room.join(undefined, "E");
    expect(room.join(undefined, "F")).toEqual({ error: "This table is full." });
  });

  it("gives a seat back to the same token after a reconnect", () => {
    const { room } = setup();
    room.join(undefined, "Ann");
    room.disconnect("tok1");
    expect(room.roomView().seats[0]!.connected).toBe(false);
    expect(room.join("tok1", "Ann")).toEqual({ seat: 0, token: "tok1" });
    expect(room.roomView().seats[0]!.connected).toBe(true);
  });

  it("only the host can add bots and start", () => {
    const { room } = setup();
    room.join(undefined, "Ann");
    room.join(undefined, "Bo");
    expect(room.addBot("tok2")).toMatch(/host/);
    expect(room.addBot("tok1")).toBeNull();
    expect(room.s.seats[2]!.name).toBe("Pebble");
    expect(room.start("tok2")).toMatch(/host/);
    expect(room.start("tok1")).toBeNull();
    expect(room.s.started).toBe(true);
  });

  it("deals once started, lets people act, and plays bots by itself", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.addBot("tok1");
    room.addBot("tok1");
    room.start("tok1");
    t.step(); // deal
    expect(room.s.game.hand!.number).toBe(1);
    const chips = total(room);
    // Play 30 hands: Ann checks or calls on her turn, bots act on their own.
    for (let i = 0; i < 2000 && room.s.game.handNo <= 30; i++) {
      const h = room.s.game.hand!;
      if (h.street !== "complete" && h.toAct === 0) {
        const p = room.s.game.seats[0]!;
        const a = h.currentBet <= p.streetBet ? { type: "check" as const } : { type: "call" as const };
        expect(room.act("tok1", a)).toBeNull();
      } else if (!t.step()) {
        if (room.s.game.seats[0]!.stack === 0) room.rebuy("tok1");
        else break;
      }
      room.takeEvents();
    }
    expect(room.s.game.handNo).toBeGreaterThan(30);
    expect(total(room) % 1000).toBe(chips % 1000); // only whole rebuys ever add chips
  });

  it("refuses moves out of turn and illegal moves", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.join(undefined, "Bo");
    room.start("tok1");
    t.step();
    const toAct = room.s.game.hand!.toAct!;
    const other = toAct === 0 ? "tok2" : "tok1";
    const mine = toAct === 0 ? "tok1" : "tok2";
    expect(room.act(other, { type: "call" })).toMatch(/not your turn/);
    expect(room.act(mine, { type: "raise", to: 999999 })).toBeTruthy();
    expect(room.act(mine, { type: "call" })).toBeNull();
  });

  it("checks or folds for a player who runs out of time, and sits them out after two", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.join(undefined, "Bo");
    room.start("tok1");
    t.step();
    const p = room.s.pending!;
    expect(p.kind).toBe("timeout");
    expect(p.at - 1_000_000).toBeGreaterThanOrEqual(TURN_MS);
    const seat = p.seat;
    t.step(); // first timeout: auto check or fold
    expect(room.s.seats[seat]!.timeouts).toBe(1);
    // Let the rest of the hand and the next ones run on timers alone.
    for (let i = 0; i < 20 && !room.s.seats[seat]!.away; i++) t.step();
    expect(room.s.seats[seat]!.away).toBe(true);
    room.back(seat === 0 ? "tok1" : "tok2");
    expect(room.s.seats[seat]!.away).toBe(false);
  });

  it("gives a disconnected player only a short time to act", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.join(undefined, "Bo");
    room.start("tok1");
    t.step();
    const seat = room.s.game.hand!.toAct!;
    room.disconnect(seat === 0 ? "tok1" : "tok2");
    const left = room.s.pending!.at - 1_000_000;
    expect(left).toBeLessThan(AWAY_TURN_MS + 3000);
  });

  it("does not deal in players who are disconnected", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.join(undefined, "Bo");
    room.addBot("tok1");
    room.start("tok1");
    room.disconnect("tok2");
    t.step();
    expect(room.s.game.seats[1]!.hole).toEqual([]);
    expect(room.s.game.seats[1]!.stack).toBe(1000);
    expect(room.s.game.seats[0]!.hole).toHaveLength(2);
  });

  it("frees a leaving player's seat after the hand and passes on the host", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.join(undefined, "Bo");
    room.addBot("tok1");
    room.start("tok1");
    t.step();
    room.leave("tok1");
    expect(room.roomView().seats[1]!.host).toBe(false);
    // Finish the hand on timers; Bo checks or calls.
    for (let i = 0; i < 50 && room.s.game.hand!.street !== "complete"; i++) {
      if (room.s.game.hand!.toAct === 1) {
        const h = room.s.game.hand!;
        room.act("tok2", h.currentBet <= room.s.game.seats[1]!.streetBet ? { type: "check" } : { type: "call" });
      } else t.step();
    }
    t.step(); // next deal settles departures
    expect(room.s.seats[0]).toBeNull();
    expect(room.roomView().seats[1]!.host).toBe(true);
  });

  it("stops dealing when no person is left watching", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.addBot("tok1");
    room.addBot("tok1");
    room.start("tok1");
    room.leave("tok1");
    expect(room.s.pending?.kind).toBe("expire");
    expect(room.empty).toBe(true);
  });

  it("each phone's update shows only its own cards", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.join(undefined, "Bo");
    room.start("tok1");
    t.step();
    const a = room.update(0, []);
    const b = room.update(1, []);
    if (a.t !== "update" || b.t !== "update") throw new Error("expected updates");
    expect(a.view.seats[0]!.hole).toHaveLength(2);
    expect(a.view.seats[1]!.hole).toHaveLength(0);
    expect(b.view.seats[0]!.hole).toHaveLength(0);
    expect(b.view.seats[1]!.hole).toHaveLength(2);
  });

  it("expires a table once nobody has been connected for a while", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.addBot("tok1");
    room.start("tok1");
    room.disconnect("tok1");
    // Let whatever is in progress finish on timers.
    for (let i = 0; i < 40 && room.s.pending?.kind !== "expire"; i++) t.step();
    expect(room.s.pending?.kind).toBe("expire");
    expect(room.s.pending!.at).toBeGreaterThanOrEqual(1_000_000 + EXPIRE_MS);
    t.step();
    expect(room.expired).toBe(true);
  });

  it("a returning player cancels the expiry", () => {
    const t = setup();
    const { room } = t;
    room.join(undefined, "Ann");
    room.disconnect("tok1");
    expect(room.s.pending?.kind).toBe("expire");
    room.join("tok1", "Ann");
    expect(room.s.pending).toBeNull();
  });
});
