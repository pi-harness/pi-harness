// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientPlugin } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { ControlRoomView } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const context = { id: "context", label: "Context management" };
const observability = { id: "observability", label: "Observability" };
const plugins: readonly ClientPlugin[] = [
  { id: "1", name: "@pi-harness/plugin-token-guard", enabled: true, state: "loaded", removable: true, category: context },
  { id: "2", name: "@pi-harness/plugin-history-compressor", enabled: true, state: "loaded", removable: true, category: context },
  { id: "3", name: "@pi-harness/plugin-cost-meter", enabled: true, state: "loaded", removable: true, category: observability },
];
const marketplace: ClientMarketplacePage = { items: [], total: 0, page: 0, pageSize: 24, hasNext: false, capabilities: [], categories: [] };

const api: ClientApi = {
  ...createClientApi(),
  getStatus: () =>
    Promise.resolve({
      status: "ready",
      model: "test/model",
      messages: 0,
      events: 0,
      sessionId: "active",
      cwd: "/workspace",
      agentDir: "/sessions",
      plugins: [],
    }),
  getSession: () => Promise.resolve({ sessionId: "active", messages: [], entries: [], events: [] }),
  listSessions: () => Promise.resolve({ items: [], total: 0, page: 0, pageSize: 30, hasNext: false }),
  listMarketplace: () => Promise.resolve(marketplace),
  getFiles: () => Promise.resolve({ items: [], repository: false }),
  getWorkspaceFiles: () => Promise.resolve({ items: [], truncated: false }),
  listModels: () => Promise.resolve([]),
  listProviders: () => Promise.resolve([]),
  listPlugins: () => Promise.resolve(plugins),
  listPluginPanels: () => Promise.resolve([]),
  listCommands: () => Promise.resolve([]),
  listWorkspaces: () => Promise.resolve([]),
  subscribeEvents: () => () => {},
};

const chips = (): string[] => [...document.querySelectorAll(".marketplace-category")].map((chip) => chip.textContent ?? "");
const search = (): HTMLInputElement => {
  const input = document.querySelector('input[aria-label="Search installed plugins"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("no installed plugin search box");
  return input;
};

// React tracks the last value it wrote to the node and swallows a change event that does not move past it, so the assignment has to go through the prototype setter rather than the instance property React shadowed.
const typeQuery = (text: string): void => {
  const input = search();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  locale = activeLocale();
  await setLocale("en");
  window.history.replaceState({}, "", "/?page=plugins");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await flush(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await setLocale(locale);
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  window.history.replaceState({}, "", "/");
});

test("counts the categories the current search left behind and stops offering the emptied ones", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  expect(chips()).toEqual(["All3", "Context management2", "Observability1"]);

  await flush(() => typeQuery("token"));
  expect(document.querySelector(".plugins-toolbar [aria-live]")?.textContent).toBe("1 / 3 plugins");
  expect(chips()).toEqual(["All1", "Context management1", "Observability0"]);
  const emptied = [...document.querySelectorAll<HTMLButtonElement>(".marketplace-category")].find((chip) => chip.textContent === "Observability0");
  expect(emptied?.disabled).toBe(true);

  await flush(() => typeQuery("zzzz"));
  expect(chips()).toEqual(["All0", "Context management0", "Observability0"]);
});

test("keeps a category the search emptied on the rail so the chosen facet survives a keystroke", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  const observabilityChip = [...document.querySelectorAll<HTMLButtonElement>(".marketplace-category")].find((chip) => chip.textContent === "Observability1");
  await flush(() => observabilityChip?.click());
  expect(document.querySelector('.marketplace-category[aria-pressed="true"]')?.textContent).toBe("Observability1");

  await flush(() => typeQuery("token"));
  expect(document.querySelector('.marketplace-category[aria-pressed="true"]')?.textContent).toBe("Observability0");
  // "All" is the way back out of a facet the query emptied, so it must stay clickable even at zero.
  const all = [...document.querySelectorAll<HTMLButtonElement>(".marketplace-category")].find((chip) => chip.textContent?.startsWith("All"));
  expect(all?.disabled).toBe(false);
});
