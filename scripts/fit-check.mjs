// Layout check: load a build at many desktop sizes and measure whether the
// board, your seat and the opponents fit inside the table without overlapping.
//   npx vite build --base ./ --outDir <folder> --mode localtest
//   node scripts/fit-check.mjs file:///<folder>/index.html [screenshot folder]
// (In Git Bash, prefix the build with MSYS_NO_PATHCONV=1 so "./" stays "./".)
import puppeteer from "puppeteer-core";

const [url, shots] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--allow-file-access-from-files"],
});
let failed = false;
const sizes = [
  [900, 700], [940, 700], [1000, 760], [1060, 800], [1100, 720], [1180, 900], [1280, 720], [1440, 900], [1920, 1080], [899, 700],
];
for (const [w, h] of sizes) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector(".board .card-slot, .board .card", { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 1500));
  const r = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const felt = box(document.querySelector(".felt"));
    // The felt's inner edge: the rail is drawn inside the padding.
    const inner = { left: felt.left + 14, right: felt.right - 14, top: felt.top, bottom: felt.bottom };
    const out = (el) => {
      const b = box(el);
      return Math.max(0, inner.left - b.left, b.right - inner.right, b.bottom - inner.bottom);
    };
    const board = document.querySelector(".board");
    const me = document.querySelector(".seat--me");
    const seats = [...document.querySelectorAll(".seat--opp")];
    // Opponent seats overlapping each other.
    let overlap = 0;
    for (let i = 0; i < seats.length; i++)
      for (let j = i + 1; j < seats.length; j++) {
        const a = box(seats[i]), b = box(seats[j]);
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 0 && y > 0) overlap = Math.max(overlap, Math.min(x, y));
      }
    return {
      layout: getComputedStyle(document.getElementById("app")).display,
      felt: Math.round(felt.width),
      card: Math.round(box(document.querySelector(".board > *")).width),
      boardOut: Math.round(out(board)),
      meOut: me ? Math.round(out(me)) : 0,
      seatsOut: Math.round(Math.max(0, ...seats.map(out))),
      overlap: Math.round(overlap),
    };
  });
  console.log(`${w}x${h}`, JSON.stringify(r));
  if (r.boardOut || r.meOut || r.seatsOut || r.overlap) failed = true;
  if (shots && [900, 1000, 1100].includes(w)) await page.screenshot({ path: `${shots}/fit-${w}.png` });
  await page.close();
}
await browser.close();
console.log(failed ? "PROBLEM: something sticks out of the table or overlaps." : "Layout check passed.");
process.exit(failed ? 1 : 0);
