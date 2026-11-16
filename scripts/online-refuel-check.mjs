// End-to-end check: at an online table with a bot, two players shove until one
// runs out of chips. While the others keep playing, the broke player must always
// see the refuel button, and refueling must deal them back in.
//   node scripts/online-refuel-check.mjs [url]   (default: the published site)
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "https://ethanmanco.github.io/pocket-pixels/";
const CODE = "BRK" + "ABCDEFGHJK"[Math.floor(Math.random() * 10)] + "ABCDEFGHJK"[Math.floor(Math.random() * 10)];
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function phone(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 375, height: 760 });
  page.on("pageerror", (e) => console.log(name, "pageerror", e.message));
  await page.goto(`${BASE}?table=${CODE}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#name-input");
  await page.type("#name-input", name);
  await page.click('[data-m="sit"]');
  await page.waitForFunction(() => document.querySelectorAll(".seat").length >= 2);
  return { name, page };
}
const state = (p) =>
  p.page.evaluate(() => ({
    stack: document.querySelector(".seat--me .stack")?.textContent ?? "",
    note: document.querySelector(".controls-note")?.textContent ?? "",
    buttons: [...document.querySelectorAll(".controls button")].map((b) => `${b.textContent.trim()}${b.disabled ? "(off)" : ""}`).join(" | "),
    log: document.querySelector(".log")?.textContent ?? "",
    cards: document.querySelectorAll(".seat--me .seat-cards .card").length,
  }));

const a = await phone("Ann");
const b = await phone("Bo");
await a.page.waitForSelector('[data-do="addbot"]');
await a.page.click('[data-do="addbot"]');
await sleep(500);
await a.page.waitForSelector('[data-do="start"]:not(:disabled)');
await a.page.click('[data-do="start"]');
let broke = null;
const t0 = Date.now();
while (!broke && Date.now() - t0 < 120_000) {
  for (const p of [a, b]) {
    const s = await state(p);
    if (s.stack === "0" && / wins /.test(s.log) && !/^You /.test(s.log) && !/Split/.test(s.log)) { broke = p; break; }
    const shove = await p.page.$('.controls [data-preset="all"]');
    if (shove) {
      await shove.click();
      await p.page.click('[data-act="raise"]').catch(() => {});
    } else {
      await p.page.click('[data-act="call"]').catch(() => {});
      await p.page.click('[data-act="check"]').catch(() => {});
    }
  }
  await sleep(300);
}
if (!broke) { console.log("nobody went broke"); process.exit(1); }
console.log(`${broke.name} went broke. What they see over the next 12 seconds:`);
const other = broke === a ? b : a;
let seen = 0;
let samples = 0;
for (let k = 0; k < 60; k++) {
  const st = await state(broke);
  samples++;
  if (st.buttons.includes("Refuel") || st.buttons.includes("Rebuy")) seen++;
  await sleep(250);
}
console.log(`Refuel button visible in ${seen} of ${samples} samples over 15 seconds while the others play`);
let failed = seen < samples;
for (let i = 0; i < 4; i++) {
  console.log(" ", JSON.stringify(await state(broke)));
  // The other player keeps checking or calling if a hand is dealt.
  await other.page.click('[data-act="check"]').catch(() => {});
  await other.page.click('[data-act="call"]').catch(() => {});
  await sleep(1500);
}
const rebuy = await broke.page.$('[data-do="rebuy"]');
console.log("Rebuy button present:", !!rebuy);
if (rebuy) {
  await rebuy.click();
  await sleep(1500);
  console.log("right after refuel:", JSON.stringify(await state(broke)));
  // Keep the others playing until Ann is dealt cards again.
  let dealt = false;
  for (let i = 0; i < 60 && !dealt; i++) {
    await other.page.click('[data-act="check"]').catch(() => {});
    await other.page.click('[data-act="call"]').catch(() => {});
    const st = await state(broke);
    if (st.cards === 2 && st.stack !== "0" && !/back in/.test(st.note)) dealt = true;
    await sleep(500);
  }
  console.log("dealt back in:", dealt, JSON.stringify(await state(broke)));
  if (!dealt) failed = true;
}
else failed = true;
await browser.close();
console.log(failed ? "PROBLEM: the broke player could not get back in." : "Refuel check passed.");
process.exit(failed ? 1 : 0);
