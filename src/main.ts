import "@fontsource/silkscreen/latin-400.css";
import "@fontsource/silkscreen/latin-700.css";
import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { TableApp } from "./ui/app";

// Up to five players: you and four computer opponents, clockwise from your left.
const app = new TableApp(document.getElementById("app")!, [
  { name: "Pebble", personality: "cautious", avatar: "pebble" },
  { name: "Juniper", personality: "loose", avatar: "juniper" },
  { name: "Blaze", personality: "aggressive", avatar: "blaze" },
  { name: "Rook", personality: "steady", avatar: "rook" },
]);
app.start();

// Works offline once loaded, and installs to the home screen.
registerSW({ immediate: true });
