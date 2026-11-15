import "@fontsource/silkscreen/latin-400.css";
import "@fontsource/silkscreen/latin-700.css";
import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { isValidCode } from "./online/protocol";
import { type Mode, TableApp } from "./ui/app";

// ?table=CODE opens an online table; otherwise you play solo against bots.
const code = new URLSearchParams(location.search).get("table")?.toUpperCase() ?? "";
const mode: Mode = isValidCode(code)
  ? { kind: "online", code }
  : {
      kind: "local",
      // Up to five players: you and four computer opponents, clockwise from your left.
      roster: [
        { name: "Pebble", personality: "cautious", avatar: "pebble" },
        { name: "Juniper", personality: "loose", avatar: "juniper" },
        { name: "Blaze", personality: "aggressive", avatar: "blaze" },
        { name: "Rook", personality: "steady", avatar: "rook" },
      ],
    };

new TableApp(document.getElementById("app")!, mode).start();

// Works offline once loaded, and installs to the home screen.
registerSW({ immediate: true });
