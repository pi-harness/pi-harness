// @vitest-environment happy-dom

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

// A DOM environment answers `new URL(relative, import.meta.url)` with the page's own scheme, which no file reader will take, so the repository paths are built from the directory instead.
const source = async (): Promise<string> => readFile(join(import.meta.dirname, "../src/react-room.tsx"), "utf8");
const catalog = async (id: string): Promise<Record<string, string>> =>
  JSON.parse(await readFile(join(import.meta.dirname, `../src/locales/${id}.json`), "utf8")) as Record<string, string>;
const locales = ["de", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-TW"] as const;

const marketplace: ClientMarketplacePage = { items: [], total: 0, page: 0, pageSize: 24, hasNext: false, capabilities: [], categories: [] };
const config: ClientPiConfig = {
  path: "/workspace/pi.toml",
  scope: "project",
  source: "",
  settings: {
    transport: "http",
    steeringMode: "queue",
    followUpMode: "auto",
    hideThinkingBlock: false,
    compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 2048 },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 500 },
    terminal: { showImages: true, imageAutoResize: true, autocompleteMaxVisible: 8 },
    advanced: {
      quietStartup: false,
      projectTrust: "ask",
      showCacheMissNotices: false,
      enableAnalytics: false,
      enableInstallTelemetry: false,
      doubleEscapeAction: "clear",
      treeFilterMode: "all",
      mermaid: "off",
    },
  },
};

const api: ClientApi = {
  ...createClientApi(),
  getConfig: () => Promise.resolve(config),
  getStatus: () =>
    Promise.resolve({
      status: "ready",
      model: "test/model",
      messages: 0,
      events: 0,
      sessionId: "alpha",
      cwd: "/workspace",
      agentDir: "/sessions",
      plugins: [],
    }),
  getSession: () => Promise.resolve({ sessionId: "alpha", messages: [], entries: [], events: [] }),
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
};

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
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

const mermaidOptions = (): string[] => {
  const field = [...document.querySelectorAll(".config-field")].find((item) => item.querySelector("span")?.textContent?.includes("Mermaid"));
  return [...(field?.querySelectorAll("option") ?? [])].map((option) => option.textContent ?? "");
};

describe("console chrome copy", () => {
  test("offers the Mermaid off state as a setting, not as the dialog dismiss verb", async () => {
    await flush(() => root.render(createElement(ControlRoomView, { api })));
    // The runtime configuration form only appears once the config read has settled.
    await act(async () => {
      for (let step = 0; step < 8; step += 1) await Promise.resolve();
    });
    expect(mermaidOptions()).toEqual(["Do not render", "Render when finished", "Streaming rendering"]);
  });

  // "Close" is what every catalog makes of the dismiss verb, and the "off" state word is an adjective the Romance catalogs inflected for the feature that already used it, so neither can stand in for this option.
  test("names the Mermaid off option without borrowing a word tuned for somewhere else", async () => {
    for (const id of locales) {
      const entries = await catalog(id);
      const option = entries["不渲染"];
      expect([id, option]).toEqual([id, expect.stringMatching(/\S/u)]);
      expect([id, option === entries["关闭"], option === entries["已关闭"]]).toEqual([id, false, false]);
    }
  });

  test("names the real restore path in the archive confirmation, in every catalog", async () => {
    const key = "归档后会从默认列表隐藏；在会话工具中打开「显示归档会话」，再对该会话选择「恢复会话」。";
    const text = await source();
    expect(text).toContain(`t("${key}")`);
    expect(text).not.toContain("归档后会从默认列表隐藏，之后仍可在会话工具中恢复。");
    for (const id of locales) {
      const entries = await catalog(id);
      // Restore lives on the archived session's own row, which only appears once Show archived sessions is turned on, so the copy has to name both steps in that catalog's own wording.
      const reveal = entries["显示归档会话"];
      const restore = entries["恢复会话"];
      expect([id, reveal, restore]).toEqual([id, expect.stringMatching(/\S/u), expect.stringMatching(/\S/u)]);
      expect([id, entries[key]?.includes(reveal), entries[key]?.includes(restore)]).toEqual([id, true, true]);
    }
  });
});
