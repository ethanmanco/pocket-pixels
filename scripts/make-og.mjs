// Render the link preview image to public/og.png (1200 x 630).
//   npm run og
// Starts a Vite dev server for scripts/og/index.html, screenshots it, stops.
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

const server = await createServer({ server: { port: 5197, strictPort: false }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  // Reduced motion holds the twinkling stars still.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.goto(new URL("scripts/og/index.html", base).href, { waitUntil: "networkidle0" });
  await page.waitForSelector("body.ready");
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: process.argv[2] ?? "public/og.png" });
  console.log("Wrote", process.argv[2] ?? "public/og.png");
} finally {
  await browser.close();
  await server.close();
}
