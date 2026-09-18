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
// The gateway answers /api/status out of the live session rather than out of a file, and POST /api/model replaces the model in that same session, so the fake keeps one mutable pair the way the harness does. The thinking level moves with it because Pi re-derives the session's level for whichever model it just switched to.
let sessionModel = "everyapi/deepseek-v4-flash";
let sessionThinkingLevel = "off";
const api: ClientApi = {
  ...createClientApi(),
  getStatus: () =>
    Promise.resolve({
      status: "ready",
      model: sessionModel,
      thinkingLevel: sessionThinkingLevel,
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
  listModels: () =>
    Promise.resolve([
      {
        provider: "everyapi",
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        reasoning: false,
        contextWindow: 1048576,
        active: sessionModel === "everyapi/deepseek-v4-flash",
      },
      {
        provider: "everyapi",
        id: "gpt-5.6-luna",
        name: "gpt-5.6-luna",
        reasoning: true,
        contextWindow: 400000,
        active: sessionModel === "everyapi/gpt-5.6-luna",
      },
    ]),
  listProviders: () => Promise.resolve([{ provider: "everyapi", name: "everyapi", active: true, auth: { configured: true }, models: [] }]),
  selectModel: (provider, model) => {
    sessionModel = `${provider}/${model}`;
    sessionThinkingLevel = model === "gpt-5.6-luna" ? "medium" : "off";
    return Promise.resolve({ model: { provider, id: model, name: model, reasoning: model === "gpt-5.6-luna", contextWindow: null, active: true } });
  },
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
    (item) => item.querySelector("header strong")?.textContent === "Active model and thinking level",
  );
  if (section === undefined) throw new Error("no active model section");
  return section;
};
const rows = (): string[] => [...modelSection().querySelectorAll(".config-field")].map((row) => row.textContent ?? "");
const sectionNote = (): string => modelSection().querySelector("header small")?.textContent ?? "";

const nativeSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");

// React ignores a value it wrote itself, so the native setter plus a change event is what picking an option looks like from here.
async function pickComposerModel(selection: string): Promise<void> {
  const picker = document.querySelector<HTMLSelectElement>('select[aria-label="Models"]');
  if (picker === null) throw new Error("the composer model picker is not mounted");
  expect(picker.disabled).toBe(false);
  await flush(() => {
    nativeSelectValue?.set?.call(picker, selection);
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(() => {});
  await flush(() => {});
}

async function openRunningConfiguration(): Promise<void> {
  const settings = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === "Settings");
  if (settings === undefined) throw new Error("the settings control is not mounted");
  await flush(() => settings.click());
  const tab = [...document.querySelectorAll<HTMLButtonElement>(".settings-tab")].find((item) => item.textContent === "Running configuration");
  if (tab === undefined) throw new Error("the running configuration tab is not mounted");
  await flush(() => tab.click());
  await flush(() => {});
}

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  updates.length = 0;
  sessionModel = "everyapi/deepseek-v4-flash";
  sessionThinkingLevel = "off";
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

// pi-models resolves the provider and model pair from the profile and pi-runtime seeds the session's thinking level, neither of them reading settings.json, so offering the settings keys here promised a session that would never be started.
test("reports the model the session is actually running instead of the settings keys nothing reads", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  await flush(() => {});

  expect(rows()).toEqual(["Providerseveryapi", "Modelsdeepseek-v4-flash", "Thinking leveloff"]);
  // The settings file's own defaults name a different model; showing them here claimed a session would start with them.
  expect(modelSection().textContent).not.toContain("kimi-k3");
  expect(modelSection().querySelector("select")).toBeNull();
  expect(updates).toEqual([]);
});

// This section reads the live session, and the console changes that session itself through the composer's model picker, so it must not tell the reader that the booted profile decides these values and that only a profile edit plus a restart can move them.
test("describes values this console can move, not a profile the reader would have to edit", async () => {
  window.history.replaceState({}, "", "/");
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  await flush(() => {});

  await pickComposerModel("everyapi/gpt-5.6-luna");
  await openRunningConfiguration();

  // The reader picked this model in the composer a moment ago; the row has to agree with what they did rather than name what the profile asked for.
  expect(rows()).toEqual(["Providerseveryapi", "Modelsgpt-5.6-luna", "Thinking levelmedium"]);
  expect(sectionNote()).toContain("model picker");
  expect(sectionNote()).not.toContain("cannot change");
  // The thinking level Pi settles on is derived per model, so a note pointing at the profile's literal value would name a level the reader cannot find in their profile.
  expect(sectionNote()).not.toContain("restart");
});
