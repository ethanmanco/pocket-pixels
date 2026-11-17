// End-to-end check of the table menu: the host removes a bot and a person,
// a friend takes a break and comes back, and the open menu keeps up live.
//   node scripts/online-host-check.mjs [url]   (default: the published site)
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "https://ethanmanco.github.io/pocket-pixels/";
const CODE = "HST" + "ABCDEFGHJK"[Math.floor(Math.random() * 10)] + "ABCDEFGHJK"[Math.floor(Math.random() * 10)];
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

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
  return page;
}
const openMenu = async (page) => {
  await page.click('[data-ui="menu"]');
  await page.waitForSelector("dialog[open] .seat-list");
};
const seatList = (page) =>
  page.$$eval("dialog[open] .seat-list li", (lis) => lis.map((li) => li.textContent.replace(/\s+/g, " ").trim()));
const waitFor = async (page, fn, arg, ms = 8000) => {
  try {
    await page.waitForFunction(fn, { timeout: ms }, arg);
    return true;
  } catch {
    return false;
  }
};
const listHas = (text) => [...document.querySelectorAll("dialog[open] .seat-list li")].some((li) => li.textContent.includes(text));

const ann = await phone("Ann");
const bo = await phone("Bo");

// Host opens the menu, adds a bot from it, and sees it appear without reopening.
await openMenu(ann);
await ann.click('dialog[open] [data-m="addbot"]');
check(await waitFor(ann, listHas, "Pebble"), "bot appears in the open menu right away");
console.log("     host sees:", JSON.stringify(await seatList(ann)));
if (process.env.SHOT_MENU) {
  await ann.$eval('[data-live="table"]', (e) => e.scrollIntoView({ block: "start" }));
  await ann.screenshot({ path: process.env.SHOT_MENU });
}

// Host removes the bot: it disappears from the open menu right away.
await ann.click('dialog[open] [data-m="remove"][data-kind="bot"]');
check(await waitFor(ann, (t) => ![...document.querySelectorAll("dialog[open] .seat-list li")].some((li) => li.textContent.includes(t)), "Pebble"),
  "removed bot disappears from the open menu right away");

// Bo can't remove anyone.
await openMenu(bo);
check((await bo.$$('dialog[open] [data-m="remove"]')).length === 0, "a non-host gets no Remove buttons");
console.log("     Bo sees:", JSON.stringify(await seatList(bo)));

// Bo takes a break; Ann's open menu shows it live.
await bo.click('dialog[open] [data-m="break"]');
check(await waitFor(ann, listHas, "on a break"), "host's open menu shows Bo on a break");
check(await waitFor(bo, () => /sitting out/i.test(document.querySelector(".controls")?.textContent ?? "")), "Bo's screen says he is sitting out");
// Bo comes back from the main screen.
await bo.click('[data-do="back"]');
check(await waitFor(ann, (t) => ![...document.querySelectorAll("dialog[open] .seat-list li")].some((li) => li.textContent.includes(t)), "on a break"),
  "host's open menu shows Bo back");

// Start a game with a bot so Bo holds cards, then remove Bo (two taps).
await ann.click('dialog[open] [data-m="addbot"]');
await waitFor(ann, listHas, "Pebble");
await ann.click('dialog[open] [data-m="close"]');
await ann.waitForSelector('[data-do="start"]:not(:disabled)');
await ann.click('[data-do="start"]');
await sleep(2500);
await openMenu(ann);
const boBtn = 'dialog[open] [data-m="remove"][data-kind="human"]';
await ann.click(boBtn);
check((await ann.$eval(boBtn, (b) => b.textContent)) === "Sure?", "removing a person asks for a second tap");
await ann.click(boBtn);
check(await waitFor(bo, () => /removed you/.test(document.querySelector(".toast")?.textContent ?? "") && !location.search.includes("table"), null, 20000),
  "Bo lands on the home screen with 'The host removed you from the table.'");
console.log("     Bo's note:", JSON.stringify(await bo.$eval(".toast", (e) => e.textContent).catch(() => "(none)")));
if (process.env.SHOT) await bo.screenshot({ path: process.env.SHOT });
// Ann keeps playing (checking or calling behind the open menu) so the hand ends.
const play = setInterval(() => {
  ann.evaluate(() => (document.querySelector('[data-act="check"]:not(:disabled)') ?? document.querySelector('[data-act="call"]:not(:disabled)'))?.click()).catch(() => {});
}, 500);
check(await waitFor(ann, (t) => ![...document.querySelectorAll("dialog[open] .seat-list li")].some((li) => li.textContent.includes(t)), "Bo", 40000),
  "Bo is gone from the host's menu once his hand ends");
clearInterval(play);
console.log("     host sees:", JSON.stringify(await seatList(ann)));

// Leave game asks for a second tap.
await ann.click('dialog[open] [data-m="leave"]');
check((await ann.$eval('dialog[open] [data-m="leave"]', (b) => b.textContent)) === "Tap again to leave", "Leave game asks for a second tap");
await ann.click('dialog[open] [data-m="leave"]');
check(await waitFor(ann, () => !location.search.includes("table")), "host leaves to the home screen");

// Stats show hands lost.
const stats = await ann.evaluate(() => {
  document.querySelector('[data-ui="menu"]').click();
  return document.querySelector("dialog[open] .stats")?.textContent.replace(/\s+/g, " ");
});
check(/Hands lost/.test(stats ?? ""), "stats list hands lost");
console.log("     stats:", stats);

await browser.close();
console.log(failed ? "Host check FAILED." : "Host check passed.");
process.exit(failed ? 1 : 0);
