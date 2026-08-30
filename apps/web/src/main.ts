import { AppWebEntry } from "@pi-harness/client-web";
import "./style.css";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Pi Harness web app is missing #root");
const entry = new AppWebEntry(root);
void entry.run().catch((error: unknown) => {
  root.textContent = error instanceof Error ? error.message : String(error);
});
