import "./style.css";
import { TableApp } from "./ui/app";

const app = new TableApp(document.getElementById("app")!, [
  { name: "Blaze", personality: "aggressive", color: "#e4572e" },
]);
app.start();
