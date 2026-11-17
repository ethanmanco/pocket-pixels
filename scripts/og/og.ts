// The link preview image (1200 x 630), drawn with the game's own art:
// the space backdrop, the pixel table, real cards, chips and avatars.
import "@fontsource/silkscreen/latin-400.css";
import "@fontsource/silkscreen/latin-700.css";
import "../../src/style.css";
import "./og.css";
import { parseCards } from "../../src/engine/cards";
import { avatarBg, avatarSVG } from "../../src/ui/avatars";
import { cardEl } from "../../src/ui/cards";
import { chipsSVG, pileColumns } from "../../src/ui/chips";
import { paintSpace } from "../../src/ui/space";
import { paintTable } from "../../src/ui/table";

const space = document.createElement("canvas");
space.className = "space";
const twinkles = document.createElement("div");
twinkles.className = "twinkles";
document.body.prepend(space, twinkles);
paintSpace(space, twinkles);

const AVATARS = ["astronaut-2", "alien-1", "vampire-1", "robot-2", "ufo-1", "mutant-1"];

const og = document.getElementById("og")!;
og.innerHTML = `
  <section class="pitch">
    <p class="og-tag">8-bit Texas Hold'em</p>
    <h1 class="logo"><span>Pocket</span><span class="logo-2">Pixels</span></h1>
    <ul class="facts">
      <li>Play bots or friends online</li>
      <li>4 bot levels, easy to insane</li>
      <li>Free. Play chips only.</li>
    </ul>
    <div class="faces">
      ${AVATARS.map((k) => `<span class="face" style="background:${avatarBg(k)}">${avatarSVG(k, 4)}</span>`).join("")}
    </div>
  </section>
  <section class="scene">
    <div class="og-table">
      <div class="og-pot"><span class="pot-amount">Pot 8,750</span>${chipsSVG(pileColumns(8750, 6, 6), 4)}</div>
      <div class="og-board"></div>
      <div class="og-win">Royal flush</div>
    </div>
    <div class="og-hole"></div>
  </section>
`;

const board = og.querySelector(".og-board")!;
for (const c of parseCards("Ts Js Qs 7h 2d")) board.append(cardEl(c, "md"));
const hole = og.querySelector(".og-hole")!;
for (const c of parseCards("As Ks")) hole.append(cardEl(c, "lg"));

paintTable(og.querySelector<HTMLElement>(".og-table")!);

document.fonts.ready.then(() => document.body.classList.add("ready"));
