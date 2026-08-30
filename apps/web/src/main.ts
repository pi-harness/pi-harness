import { AppWebEntry } from "@pi-harness/client-web";
import { installCommandPalette } from "./command-palette.js";
import "./style.css";
import "./runtime.css";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Pi Harness web app is missing #root");
const entry = new AppWebEntry(root);
void entry.run().then(() => installCommandPalette(root)).catch((error: unknown) => {
  root.textContent = error instanceof Error ? error.message : String(error);
});
