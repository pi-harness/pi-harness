// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientPiConfig } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { ControlRoomView } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const marketplace: ClientMarketplacePage = { items: [], total: 0, page: 0, pageSize: 24, hasNext: false, capabilities: [], categories: [] };

// The settings file still carries these keys, because it is Pi's own settings file and the CLI reads them. What no longer happens is the console offering them as the model a session will use.
const config: ClientPiConfig = {
  path: "/sessions/settings.json",
  scope: "global",
  source: '{"defaultProvider":"everyapi","defaultModel":"kimi-k3","defaultThinkingLevel":"max"}\n',
  settings: {
    defaultProvider: "everyapi",
    defaultModel: "kimi-k3",
    defaultThinkingLevel: "max",
    transport: "auto",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    hideThinkingBlock: false,
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 },
    terminal: { showImages: false, imageAutoResize: false, autocompleteMaxVisible: 8 },
    advanced: {
      quietStartup: false,
      projectTrust: "ask",
      showCacheMissNotices: false,
      enableAnalytics: false,
      enableInstallTelemetry: false,
      doubleEscapeAction: "tree",
      treeFilterMode: "tree",
      mermaid: "off",
    },
  },
};

const updates: unknown[] = [];
const api: ClientApi = {
  ...createClientApi(),
  getStatus: () =>
    Promise.resolve({
      status: "ready",
      model: "everyapi/deepseek-v4-flash",
      thinkingLevel: "medium",
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
  listPlugins: () => Promise.resolve([]),
  listPluginPanels: () => Promise.resolve([]),
  listCommands: () => Promise.resolve([]),
  listWorkspaces: () => Promise.resolve([]),
  subscribeEvents: () => () => {},
  getConfig: () => Promise.resolve(config),
  updateConfig: (input) => {
    updates.push(input);
    return Promise.resolve(config);
  },
};

const modelSection = (): HTMLElement => {
  const section = [...document.querySelectorAll<HTMLElement>(".config-section")].find(
    (item) => item.querySelector("header strong")?.textContent === "Model defaults",
  );
  if (section === undefined) throw new Error("no model defaults section");
  return section;
};
const rows = (): string[] => [...modelSection().querySelectorAll(".config-field")].map((row) => row.textContent ?? "");

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  updates.length = 0;
  locale = activeLocale();
  await setLocale("en");
  window.history.replaceState({}, "", "/?settings=toml");
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

// pi-models resolves the provider and model pair from the profile and pi-runtime hands the session its thinking level, neither of them reading settings.json, so offering the settings keys here promised a session that would never be started.
test("reports the model the session is actually running instead of the settings keys nothing reads", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  await flush(() => {});

  expect(rows()).toEqual(["Providerseveryapi", "Modelsdeepseek-v4-flash", "Thinking levelmedium"]);
  // The settings file's own defaults name a different model; showing them here claimed a session would start with them.
  expect(modelSection().textContent).not.toContain("kimi-k3");
  expect(modelSection().querySelector("select")).toBeNull();
  expect(updates).toEqual([]);
});
