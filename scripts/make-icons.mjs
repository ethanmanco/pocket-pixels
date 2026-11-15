// Draws the app icon (a pixel poker chip with a spade) and writes the PNG and
// SVG files the web app manifest needs. Run with: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const CHIP = [
  "....KKKKKKKK....",
  "..KKrrwwwwrrKK..",
  ".KrrrrrrrrrrrrK.",
  ".KrrccccccccrrK.",
  "KwrccccKKccccrwK",
  "KwrcccKKKKcccrwK",
  "KrrccKKKKKKccrrK",
  "KrrcKKKKKKKKcrrK",
  "KrrcKKKKKKKKcrrK",
  "KwrcKKcKKcKKcrwK",
  "KwrccccKKccccrwK",
  "KrrcccKKKKcccrrK",
  ".KrrccccccccrrK.",
  ".KrrrrrrrrrrrrK.",
  "..KKrrwwwwrrKK..",
  "....KKKKKKKK....",
];
const PALETTE = { K: "#111111", r: "#d62839", w: "#f4f1de", c: "#fbf7ec" };
const BG = "#05050f";

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

/** RGBA pixels: the art scaled by `scale`, centered on a `size` square of `bg`. */
function raster(size, scale, bg) {
  const px = new Uint8Array(size * size * 4);
  const fill = bg ? hex(bg) : [0, 0, 0, 0];
  for (let i = 0; i < size * size; i++) px.set(fill, i * 4);
  const art = CHIP.length * scale;
  const off = Math.floor((size - art) / 2);
  CHIP.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      const color = hex(PALETTE[ch]);
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = ((off + y * scale + dy) * size + off + x * scale + dx) * 4;
          px.set(color, i);
        }
    });
  });
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(rows, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
// Regular icons: the chip nearly fills the square.
writeFileSync("public/icons/icon-192.png", png(192, raster(192, 11, BG)));
writeFileSync("public/icons/icon-512.png", png(512, raster(512, 30, BG)));
// Maskable: Android may crop to a circle, so keep the chip inside the safe zone.
writeFileSync("public/icons/maskable-512.png", png(512, raster(512, 20, BG)));
writeFileSync("public/icons/apple-touch-icon.png", png(180, raster(180, 10, BG)));

// Favicon as crisp SVG.
let rects = "";
CHIP.forEach((row, y) => [...row].forEach((ch, x) => {
  if (ch !== ".") rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${PALETTE[ch]}"/>`;
}));
writeFileSync(
  "public/favicon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects}</svg>\n`,
);
console.log("Icons written to public/icons and public/favicon.svg");
