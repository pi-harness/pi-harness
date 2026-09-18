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

const observability = { id: "observability", label: "Observability" };
const plugins: readonly ClientPlugin[] = [
  {
    id: "marketplace-history-compressor",
    name: "@pi-harness/plugin-history-compressor",
    enabled: true,
    state: "active",
    removable: true,
    category: observability,
  },
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
  togglePlugin: () => Promise.reject(new Error("Another marketplace plugin change is already running")),
};

const toolbar = (): HTMLElement => {
  const element = document.querySelector(".plugins-toolbar");
  if (!(element instanceof HTMLElement)) throw new Error("no installed plugin toolbar");
  return element;
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

test("reports a failed toggle next to the controls instead of below the scrolling list", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  // The live region is in the markup before anything fails, so the screen reader has something to attach the announcement to.
  const region = toolbar().querySelector('[aria-live="polite"].plugins-toolbar-message');
  expect(region).not.toBeNull();
  expect(region?.textContent).toBe("");

  const toggle = document.querySelector<HTMLButtonElement>("button.plugin-switch-button");
  await flush(() => toggle?.click());

  const error = document.querySelector('[role="alert"].plugin-action-error');
  expect(error?.textContent).toBe("A plugin operation is already running; wait for it to finish and try again.");
  // The message has to live in the toolbar, which never scrolls; in the scrolling list container it renders past the fold and nothing scrolls back to it.
  expect(toolbar().contains(error)).toBe(true);
  expect(document.querySelector(".plugins-scroll")?.contains(error)).toBe(false);
});
