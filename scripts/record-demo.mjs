// Records docs/demo.gif: one real hand at the five-player table on a phone-sized
// screen, animations and all.
//
// Needs the dev server running (npm run dev) and Chrome installed.
//   node scripts/record-demo.mjs [dev server url]
// Set CHROME_PATH if Chrome is not in the default Windows location.
//
// It first plays seeded hands at full speed (?fast) to find one worth showing
// (you win a pot of 150 or more at showdown with two pair or better against at
// least two players),
// then replays that seed at normal speed while taking screenshots.

import { mkdirSync, writeFileSync } from "node:fs";
import gifenc from "gifenc";
import { PNG } from "pngjs";
import puppeteer from "puppeteer-core";

const { GIFEncoder, applyPalette, quantize } = gifenc;

const BASE = process.argv[2] ?? "http://localhost:5183/";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const VIEWPORT = { width: 375, height: 700, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const GOOD = /with (two pair|three of a kind|straight|flush|full house|four of a kind|royal)/i;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.setViewport(VIEWPORT);

/** The same simple player every time: check when possible, otherwise call. */
const ACT = `(() => {
  const b = document.querySelector('.controls [data-act="check"]:not(:disabled)') ||
            document.querySelector('.controls [data-act="call"]:not(:disabled)');
  if (b) { b.click(); return true; }
  return false;
})()`;
const DONE = `!!document.querySelector('.controls [data-do]')`;

async function findSeed() {
  for (let seed = 1; seed <= 400; seed++) {
    await page.goto(`${BASE}?fast&seed=${seed}`, { waitUntil: "networkidle0" });
    for (let i = 0; i < 400; i++) {
      if (await page.evaluate(DONE)) break;
      await page.evaluate(ACT);
      await new Promise((r) => setTimeout(r, 5));
    }
    const info = await page.evaluate(() => ({
      log: document.querySelector(".log")?.textContent ?? "",
      shown: document.querySelectorAll(".seat--opp .seat-cards .card:not(.card--back)").length,
      bets: document.querySelector(".hand-no")?.textContent ?? "",
    }));
    const won = Number(/^You win ([\d,]+)/.exec(info.log)?.[1]?.replace(/,/g, "") ?? 0);
    if (won >= 150 && GOOD.test(info.log) && info.shown >= 4) {
      console.log(`Seed ${seed}: ${info.log}`);
      return seed;
    }
  }
  throw new Error("No good demo hand found");
}

const seed = await findSeed();
await page.goto(`${BASE}?seed=${seed}`, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);

// Play in the background: pause on each decision so the controls show, then act.
let finished = false;
const player = (async () => {
  while (!finished) {
    const ready = await page.evaluate(`!!document.querySelector('.controls [data-act]:not(:disabled)')`);
    if (ready) {
      await new Promise((r) => setTimeout(r, 900));
      await page.evaluate(ACT);
    }
    if (await page.evaluate(DONE)) finished = true;
    await new Promise((r) => setTimeout(r, 60));
  }
})();

const frames = [];
const started = Date.now();
let doneAt = 0;
while (Date.now() - started < 60_000) {
  frames.push({ buf: await page.screenshot({ type: "png" }), t: Date.now() });
  if (finished && !doneAt) doneAt = Date.now();
  if (doneAt && Date.now() - doneAt > 1200) break;
  await new Promise((r) => setTimeout(r, 40));
}
finished = true;
await player;
await browser.close();

// Encode: merge repeated frames (the earlier one just shows longer), then
// quantize each frame to its own 256-color palette.
const unique = [];
for (const f of frames) {
  const png = PNG.sync.read(f.buf);
  const last = unique[unique.length - 1];
  if (last && Buffer.compare(last.png.data, png.data) === 0) continue;
  unique.push({ png, t: f.t });
}
// DUMP=folder saves every 10th frame as a PNG, to check the recording.
if (process.env.DUMP) {
  mkdirSync(process.env.DUMP, { recursive: true });
  unique.forEach(({ png }, i) => {
    if (i % 10 === 0 || i === unique.length - 1) writeFileSync(`${process.env.DUMP}/frame-${String(i).padStart(3, "0")}.png`, PNG.sync.write(png));
  });
}
const gif = GIFEncoder();
unique.forEach(({ png, t }, i) => {
  const delay = i + 1 < unique.length ? unique[i + 1].t - t : 3000;
  const rgba = new Uint8Array(png.data);
  const palette = quantize(rgba, 256);
  gif.writeFrame(applyPalette(rgba, palette), png.width, png.height, { palette, delay: Math.max(20, delay) });
});
const kept = unique.length;
gif.finish();
mkdirSync("docs", { recursive: true });
writeFileSync("docs/demo.gif", gif.bytes());
console.log(`docs/demo.gif: ${kept} frames, ${(gif.bytes().length / 1024).toFixed(0)} KB, seed ${seed}`);
