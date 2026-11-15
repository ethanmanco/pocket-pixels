// Screenshot the game at a given screen size, for checking layouts.
//   node scripts/screenshot.mjs <url> <out.png> [width] [height] [moves]
// `moves` clicks Check or Call that many times first (use a ?fast&seed= dev URL).
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
await page.goto(url, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
for (let i = 0; i < Number(moves); i++) {
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
