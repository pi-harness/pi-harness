// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { ControlRoomView } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const marketplace: ClientMarketplacePage = { items: [], total: 0, page: 0, pageSize: 100, hasNext: false, capabilities: [], categories: [] };
// The catalogue is read at the endpoint's page-size clamp; the grid reads its own visible page, so the two are told apart by that size.
const CATALOG_PAGE_SIZE = 100;
const catalogRequests: number[] = [];

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
  listMarketplace: (_query, _capability, page = 0, pageSize = 24) => {
    if (pageSize === CATALOG_PAGE_SIZE) catalogRequests.push(page);
    return Promise.resolve(marketplace);
  },
  getFiles: () => Promise.resolve({ items: [], repository: false }),
  getWorkspaceFiles: () => Promise.resolve({ items: [], truncated: false }),
  listModels: () => Promise.resolve([]),
  listProviders: () => Promise.resolve([]),
  listPlugins: () => Promise.resolve([]),
  listPluginPanels: () => Promise.resolve([]),
  listCommands: () => Promise.resolve([]),
  listWorkspaces: () => Promise.resolve([]),
  subscribeEvents: () => () => {},
};

const openPlugins = async (): Promise<void> => {
  const link = [...document.querySelectorAll<HTMLButtonElement>(".sidebar-link")].find((item) => item.textContent?.includes("Plugins"));
  if (link === undefined) throw new Error("no plugins sidebar link");
  await flush(() => link.click());
  await flush(() => {});
};

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  catalogRequests.length = 0;
  locale = activeLocale();
  await setLocale("en");
  window.history.replaceState({}, "", "/?page=session");
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

// Reading the whole registry page by page is only worth its requests where the catalogue is consumed, which is the two plugin pages. A reader who never opens them paid for the registry on every load.
test("reads the whole catalogue only once the plugins page is opened", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  await flush(() => {});
  expect(catalogRequests).toEqual([]);

  await openPlugins();
  expect(catalogRequests).toEqual([0]);

  // Returning to the session view and back must not read it again: the catalogue is kept in state until the language changes.
  await flush(() => {
    window.history.replaceState({}, "", "/?page=session");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(document.querySelector(".plugins-page")).toBeNull();
  await openPlugins();
  expect(catalogRequests).toEqual([0]);
});
