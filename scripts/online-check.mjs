// End-to-end check of online play: two separate headless Chrome "phones" join
// one table, the host adds a bot and starts, and they play several hands.
// Checks that nobody sees anyone else's cards before showdown, that a player
// who reconnects gets their seat back, and that pages log no errors.
//
// Needs the local server running (npm run server:local) and Chrome installed.
//   node scripts/online-check.mjs [url] [screenshot folder]

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "http://localhost:8787/";
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CODE = "TST" + "ABCDEFGHJK"[Math.floor(Math.random() * 10)] + "ABCDEFGHJK"[Math.floor(Math.random() * 10)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const errors = [];
const problems = [];

async function phone(name) {
  // Separate contexts: each player has their own storage, like separate phones.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 375, height: 760, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  await page.goto(`${BASE}?table=${CODE}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#name-input");
  await page.type("#name-input", name);
  await page.click('[data-m="sit"]');
  await page.waitForFunction(() => document.querySelectorAll(".seat").length >= 2, { timeout: 10_000 });
  return { name, page, ctx };
}

const state = (page) =>
  page.evaluate(() => ({
    log: document.querySelector(".log")?.textContent ?? "",
    controls: [...document.querySelectorAll(".controls button:not(:disabled)")].map((b) => b.dataset.act ?? b.dataset.do ?? ""),
    names: [...document.querySelectorAll(".seat .name")].map((n) => n.textContent),
    // Face-up cards in front of other players, and whether a hand is still being played.
    faceUpOthers: document.querySelectorAll(".seat--opp .seat-cards .card:not(.card--back)").length,
    faceUpWho: [...document.querySelectorAll(".seat--opp .seat-cards.is-revealed")].map((c) => c.getAttribute("aria-label")).join(" | "),
    board5: document.querySelectorAll(".board .card").length,
    winnerShown: /win/i.test(document.querySelector(".log")?.textContent ?? ""),
    myCards: document.querySelectorAll(".seat--me .seat-cards .card").length,
    board: document.querySelectorAll(".board .card").length,
  }));

const ann = await phone("Ann");
const bo = await phone("Bo");

// Ann is the host: add a bot, then start.
await ann.page.waitForSelector('[data-do="addbot"]');
await ann.page.click('[data-do="addbot"]');
await sleep(400);
await ann.page.click('[data-do="start"]');

let handsSeen = 0;
let reconnected = false;
let lastLog = "";
const started = Date.now();
while (Date.now() - started < 120_000 && handsSeen < 6) {
  for (const p of [ann, bo]) {
    const s = await state(p.page);
    // Cards may only be face up once the hand is over: all five board cards out
    // and the winner announced (or a reconnect still showing the last showdown).
    const settled = s.board5 === 5 && (s.winnerShown || /onnect/.test(s.log));
    if (s.faceUpOthers > 0 && !settled) problems.push(`${p.name} saw face-up cards mid-hand: "${s.log}" [${s.faceUpWho}] board ${s.board5}`);
    if (p === ann && s.log !== lastLog && /\bwins?\b/.test(s.log)) {
      handsSeen++;
      lastLog = s.log;
      console.log(`Hand result (Ann's screen): ${s.log}`);
      if (SHOTS && handsSeen <= 2) {
        mkdirSync(SHOTS, { recursive: true });
        await ann.page.screenshot({ path: `${SHOTS}/ann-${handsSeen}.png` });
        await bo.page.screenshot({ path: `${SHOTS}/bo-${handsSeen}.png` });
      }
    }
    if (s.controls.includes("check")) await p.page.click('[data-act="check"]').catch(() => {});
    else if (s.controls.includes("call")) await p.page.click('[data-act="call"]').catch(() => {});
    else if (s.controls.includes("rebuy")) await p.page.click('[data-do="rebuy"]').catch(() => {});
  }
  // Halfway through, Bo's phone reloads (a dropped connection) and should keep the seat.
  if (handsSeen === 2 && !reconnected) {
    reconnected = true;
    await bo.page.reload({ waitUntil: "networkidle0" });
    await bo.page.waitForFunction(() => document.querySelectorAll(".seat").length >= 2, { timeout: 10_000 });
    const names = (await state(ann.page)).names;
    const boNames = (await state(bo.page)).names;
    console.log(`After Bo reconnects: Ann sees ${names.join(", ")}; Bo sees ${boNames.join(", ")}`);
    if (names.filter((n) => n === "Bo").length !== 1) problems.push(`Bo is not seated exactly once after reconnecting: ${names.join(", ")}`);
  }
  await sleep(250);
}

if (handsSeen < 6) problems.push(`Only ${handsSeen} hands finished in two minutes`);
const annNames = (await state(ann.page)).names;
console.log(`Ann's table: ${annNames.join(", ")}`);
await browser.close();

console.log(errors.length ? `Page errors:\n  ${errors.join("\n  ")}` : "No page errors.");
console.log(problems.length ? `PROBLEMS:\n  ${problems.join("\n  ")}` : "All online checks passed.");
process.exit(problems.length || errors.length ? 1 : 0);
