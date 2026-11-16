// Screenshot the game at a given screen size, for checking layouts.
//   node scripts/screenshot.mjs <url> <out.png> [width] [height] [moves]
// `moves` clicks Check or Call that many times first (use a ?fast&seed= dev URL),
// or "menu" opens the menu.
import puppeteer from "puppeteer-core";

const [url, out, w = "375", h = "812", moves = "0"] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage();
const mobile = Number(w) < 700;
await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
// SAVED='{"theme":"classic"}' preloads saved settings (ignored by ?seed= demo URLs).
if (process.env.SAVED) {
  await page.evaluateOnNewDocument((saved) => localStorage.setItem("pocket-pixels:v1", saved), process.env.SAVED);
}
await page.goto(url, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
if (moves === "menu") {
  await page.click('[data-ui="menu"]');
  await new Promise((r) => setTimeout(r, 300));
  // SCROLL=<css selector> scrolls the menu to that element.
  if (process.env.SCROLL) await page.$eval(process.env.SCROLL, (e) => e.scrollIntoView({ block: "start" }));
}
for (let i = 0; i < (Number(moves) || 0); i++) {
  await page.waitForSelector('.controls [data-act="check"]:not(:disabled), .controls [data-act="call"]:not(:disabled)', { timeout: 10_000 });
  await page.evaluate(() => {
    const b = document.querySelector('.controls [data-act="check"]:not(:disabled)') ?? document.querySelector('.controls [data-act="call"]:not(:disabled)');
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
}
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: out });
await browser.close();
