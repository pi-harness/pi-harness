import { AppWebEntry } from "@pi-harness/client-web";
import "./tailwind.css";
import "./style.css";
import "./runtime.css";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Pi Harness web app is missing #root");
const entry = new AppWebEntry(root);
try {
  void entry.run();
} catch (error: unknown) {
  root.textContent = error instanceof Error ? error.message : String(error);
}
