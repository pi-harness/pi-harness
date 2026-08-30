import { AppWebEntry } from "@pi-harness/client-web";
import "./style.css";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Pi Harness web app is missing #root");
void new AppWebEntry(root).run();
