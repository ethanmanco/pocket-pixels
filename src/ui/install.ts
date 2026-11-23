// "Put it on your home screen": a small download button in the top bar.
//   Android (and desktop Chrome or Edge): the browser's own install prompt.
//   iPhone and iPad: Safari has no prompt, so the button shows the steps.
// Hidden when the game is already running as an installed app.

import { pixelSVG } from "./pixels";

/** The install prompt Chrome-based browsers offer (not in the DOM typings yet). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

// Listen from the moment this module loads: the prompt can arrive before the
// table is drawn.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep the mini bar away; our button offers it instead
    deferred = e as InstallPromptEvent;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    changed();
  });
}

export function isIOS(): boolean {
  const nav = navigator;
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

/** Running from the home screen (or as an installed desktop app). */
export function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches
  );
}

type Way = "prompt" | "ios" | "android" | null;

function way(): Way {
  if (installed || isStandalone()) return null;
  if (deferred) return "prompt";
  if (isIOS()) return "ios";
  // Android browsers without the prompt (or before it arrives) get the menu steps.
  if (isAndroid()) return "android";
  return null;
}

// --------------------------------------------------------------------- pixel art

export const DOWNLOAD_ICON = [
  "....XX....",
  "....XX....",
  "....XX....",
  "..XXXXXX..",
  "...XXXX...",
  "....XX....",
  "X........X",
  "X........X",
  "XXXXXXXXXX",
];

/** Safari's Share button: a box with an arrow out of the top. */
const SHARE_ICON = [
  ".....X.....",
  "....XXX....",
  "...X.X.X...",
  ".....X.....",
  ".....X.....",
  ".XXX.X.XXX.",
  ".X.......X.",
  ".X.......X.",
  ".X.......X.",
  ".XXXXXXXXX.",
];

/** "Add to Home Screen": a rounded box with a plus. */
const ADD_ICON = [
  ".XXXXXXXXX.",
  "X.........X",
  "X....X....X",
  "X....X....X",
  "X..XXXXX..X",
  "X....X....X",
  "X....X....X",
  "X.........X",
  ".XXXXXXXXX.",
];

/** Safari's and Chrome's "more" buttons. */
const DOTS_ICON = ["...........", "XX..XX..XX.", "XX..XX..XX."];
const KEBAB_ICON = ["XX", "XX", "..", "XX", "XX", "..", "XX", "XX"];

const ink = (rows: string[], scale = 2) => pixelSVG(rows, { X: "currentColor" }, scale, "install-glyph");

// --------------------------------------------------------------------- the button

/**
 * Wire up the top bar's install button. It shows and hides itself as the
 * browser's install prompt comes and goes.
 */
export function initInstall(button: HTMLButtonElement, onChange: () => void = () => {}): void {
  const dialog = document.createElement("dialog");
  dialog.className = "menu install";
  dialog.setAttribute("aria-labelledby", "install-title");
  document.body.append(dialog);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || (e.target as Element).closest("[data-close]")) dialog.close();
  });

  const update = () => {
    const w = way();
    button.hidden = !w;
    button.setAttribute("aria-label", w === "prompt" ? "Install the app" : "Add to your home screen");
    onChange();
  };
  listeners.add(update);
  update();

  button.onclick = async () => {
    const w = way();
    if (w === "prompt" && deferred) {
      const e = deferred;
      deferred = null;
      await e.prompt();
      const { outcome } = await e.userChoice.catch(() => ({ outcome: "dismissed" as const }));
      if (outcome === "accepted") installed = true;
      changed();
    } else if (w === "ios" || w === "android") {
      dialog.innerHTML = w === "ios" ? iosSteps() : androidSteps();
      dialog.showModal();
    }
  };
}

function iosSteps(): string {
  return `
    <h2 id="install-title" class="menu-title">Add to home screen</h2>
    <p class="install-lead">Play full screen from an icon on your home screen. It even works offline.</p>
    <ol class="install-steps">
      <li><span class="install-key">${ink(SHARE_ICON)}</span><span>Tap the <b>Share</b> button in Safari. On newer iPhones it is inside the <span class="install-inline">${ink(DOTS_ICON, 2)}</span> menu.</span></li>
      <li><span class="install-key">${ink(ADD_ICON)}</span><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>
      <li><span class="install-key install-key--text">Add</span><span>Tap <b>Add</b>. Pocket Pixels is now on your home screen.</span></li>
    </ol>
    <p class="menu-note">In another app's browser? Open this page in Safari first. The home screen app keeps its own chips and stats.</p>
    <div class="menu-actions"><button class="btn btn--small btn--go" data-close>Got it</button></div>`;
}

function androidSteps(): string {
  return `
    <h2 id="install-title" class="menu-title">Add to home screen</h2>
    <p class="install-lead">Play full screen from an icon on your home screen. It even works offline.</p>
    <ol class="install-steps">
      <li><span class="install-key">${ink(KEBAB_ICON, 3)}</span><span>Open your browser's menu.</span></li>
      <li><span class="install-key">${ink(DOWNLOAD_ICON)}</span><span>Tap <b>Install app</b> or <b>Add to Home screen</b>.</span></li>
      <li><span class="install-key install-key--text">OK</span><span>Confirm. Pocket Pixels is now on your home screen.</span></li>
    </ol>
    <div class="menu-actions"><button class="btn btn--small btn--go" data-close>Got it</button></div>`;
}
