// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientMarketplacePlugin, type ClientPlugin } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { ControlRoomView } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const packageName = "@pi-harness/plugin-yaml-validator";
const catalogEntry: ClientMarketplacePlugin = {
  id: "yaml-validator",
  packageName,
  version: "0.1.34",
  name: "YAML Validator",
  description: "Validate YAML documents as they are written.",
  author: "Pi Harness",
  repository: "https://github.com/pi-harness/pi-harness",
  license: "MIT",
  source: "official",
  status: "verified",
  category: { id: "developer", label: "Developer tools" },
  capabilities: ["reads-files"],
  hooks: [],
  profile: { name: packageName, config: {} },
};
const marketplace: ClientMarketplacePage = {
  items: [catalogEntry],
  total: 1,
  page: 0,
  pageSize: 24,
  hasNext: false,
  capabilities: [{ id: "reads-files", label: "Read local files", count: 1 }],
  categories: [{ id: "developer", label: "Developer tools", count: 1 }],
};

const apiFor = (plugin: ClientPlugin): ClientApi => ({
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
  listPlugins: () => Promise.resolve([plugin]),
  listPluginPanels: () => Promise.resolve([]),
  listCommands: () => Promise.resolve([]),
  listWorkspaces: () => Promise.resolve([]),
  subscribeEvents: () => () => {},
});

const badges = (): string[] => [...document.querySelectorAll(".plugin-detail-content header span")].map((badge) => badge.textContent ?? "");
const infoRows = (): string[] => [...document.querySelectorAll(".plugin-detail-content aside dl > div")].map((row) => row.textContent ?? "");

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  locale = activeLocale();
  await setLocale("en");
  window.history.replaceState({}, "", `/?page=plugins&plugin=${encodeURIComponent(packageName)}`);
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

// The gateway reports a plugin waiting for a restart as enabled, so the header has to consult the state as well or it contradicts the action button and the run status on its own page.
test("says a restart-pending plugin is waiting rather than running", async () => {
  const plugin: ClientPlugin = { id: "marketplace-yaml-validator", name: packageName, enabled: true, state: "restart-required", removable: true };
  await flush(() => root.render(createElement(ControlRoomView, { api: apiFor(plugin) })));

  expect(badges()).toContain("Effective after restart");
  expect(badges()).not.toContain("Running");
  expect(document.querySelector(".plugin-detail-action")?.textContent).toBe("Waiting for a restart");
});

test("keeps the running badge for a loaded plugin", async () => {
  const plugin: ClientPlugin = { id: "marketplace-yaml-validator", name: packageName, enabled: true, state: "active", removable: true };
  await flush(() => root.render(createElement(ControlRoomView, { api: apiFor(plugin) })));

  expect(badges()).toContain("Running");
  expect(badges()).not.toContain("Effective after restart");
});

// The version on disk is the one this page describes; the catalogue's pin is only what a fresh install would take, so it is named as such and only when the two differ.
test("prints the installed version and names the catalogue pin only when it has moved on", async () => {
  const drifted: ClientPlugin = {
    id: "marketplace-yaml-validator",
    name: packageName,
    enabled: true,
    state: "active",
    removable: true,
    installedVersion: "0.1.32",
  };
  await flush(() => root.render(createElement(ControlRoomView, { api: apiFor(drifted) })));

  expect(document.querySelector(".plugin-detail-content header code")?.textContent).toBe(`${packageName} · v0.1.32`);
  expect(infoRows()).toContain("Installed version0.1.32");
  expect(infoRows()).toContain("Latest reviewed0.1.34");

  await flush(() => root.unmount());
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const current: ClientPlugin = { ...drifted, installedVersion: "0.1.34" };
  await flush(() => root.render(createElement(ControlRoomView, { api: apiFor(current) })));

  expect(infoRows()).toContain("Installed version0.1.34");
  expect(infoRows().some((row) => row.startsWith("Latest reviewed"))).toBe(false);
});

// The gateway leaves the installed version out when it cannot read the package's manifest, and the catalogue's pin is the version an install would take today rather than the one on disk. Printing it under "Installed version" would state as fact something nobody read off this machine.
test("falls back to the catalogue pin under a neutral label when nothing read a version off disk", async () => {
  const unread: ClientPlugin = { id: "marketplace-yaml-validator", name: packageName, enabled: true, state: "active", removable: true };
  await flush(() => root.render(createElement(ControlRoomView, { api: apiFor(unread) })));

  expect(infoRows()).toContain("Version0.1.34");
  expect(infoRows().some((row) => row.startsWith("Installed version"))).toBe(false);
  expect(infoRows().some((row) => row.startsWith("Latest reviewed"))).toBe(false);
});
