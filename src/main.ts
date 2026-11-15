import "./style.css";
import { TableApp } from "./ui/app";

// Five players by default: you and four computer opponents, clockwise from your left.
const app = new TableApp(document.getElementById("app")!, [
  { name: "Pebble", personality: "cautious", color: "#8ecae6" },
  { name: "Juniper", personality: "loose", color: "#90be6d" },
  { name: "Blaze", personality: "aggressive", color: "#e4572e" },
  { name: "Rook", personality: "steady", color: "#b388eb" },
]);
app.start();
