// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientMarketplacePlugin } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { ControlRoomView } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const reviewer = {
  id: "reviewer-bot",
  name: "Reviewer Bot",
  packageName: "@pi-harness/plugin-reviewer-bot",
  version: "0.1.32",
  repository: "https://github.com/pi-harness/pi-harness/tree/main/packages/plugins/reviewer-bot",
  description: "Review a change before it is committed.",
  profile: { name: "@pi-harness/plugin-reviewer-bot", config: {} },
};
const verifier: ClientMarketplacePlugin = {
  id: "change-verifier",
  packageName: "@pi-harness/plugin-change-verifier",
  version: "0.1.31",
  name: "Change Verifier",
  description: "Verify a change against the tests it claims to pass.",
  author: "Pi Harness",
  repository: "https://github.com/pi-harness/pi-harness",
  license: "MIT",
  source: "official",
  status: "verified",
  category: { id: "developer", label: "Developer tools" },
  capabilities: ["runs-commands"],
  hooks: [],
  dependencies: ["reviewer-bot"],
  profile: { name: "@pi-harness/plugin-change-verifier", config: {} },
  plan: [
    reviewer,
    {
      ...reviewer,
      id: "change-verifier",
      name: "Change Verifier",
      packageName: "@pi-harness/plugin-change-verifier",
      version: "0.1.31",
      description: "Verify a change against the tests it claims to pass.",
      profile: { name: "@pi-harness/plugin-change-verifier", config: {} },
    },
  ],
};
const marketplace: ClientMarketplacePage = {
  items: [verifier],
  total: 1,
  page: 0,
  pageSize: 24,
  hasNext: false,
  capabilities: [{ id: "runs-commands", label: "Run local commands", count: 1 }],
  categories: [{ id: "developer", label: "Developer tools", count: 1 }],
};

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
  window.history.replaceState({}, "", "/?page=marketplace&plugin=change-verifier");
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

// Install runs the whole plan, so a page that shows only this entry's own profile row understates what pressing the button does to the machine.
test("names the packages install pulls in and shows the profile rows it writes for all of them", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  await flush(() => {});

  const page = document.querySelector(".marketplace-page")?.textContent ?? "";
  expect(page).toContain("Dependencies");
  expect(page).toContain("Reviewer Bot");
  expect(page).toContain("@pi-harness/plugin-reviewer-bot · v0.1.32");
  const sourceLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="https://github.com/pi-harness"]')].map((link) => link.href);
  expect(sourceLinks).toContain(reviewer.repository);

  const profileBlock = [...document.querySelectorAll("pre code")].map((block) => block.textContent ?? "").at(-1) ?? "";
  const written = JSON.parse(profileBlock) as readonly { name: string }[];
  // Dependency first, this plugin last: the same order the gateway writes them in.
  expect(written.map((entry) => entry.name)).toEqual(["@pi-harness/plugin-reviewer-bot", "@pi-harness/plugin-change-verifier"]);
});

test("keeps the single profile row for an entry that installs nothing but itself", async () => {
  const alone: ClientMarketplacePlugin = { ...verifier, dependencies: undefined, plan: undefined };
  const soloApi: ClientApi = { ...api, listMarketplace: () => Promise.resolve({ ...marketplace, items: [alone] }) };
  await flush(() => root.render(createElement(ControlRoomView, { api: soloApi })));
  await flush(() => {});

  expect(document.querySelector(".marketplace-page")?.textContent).not.toContain("Dependencies");
  const profileBlock = [...document.querySelectorAll("pre code")].map((block) => block.textContent ?? "").at(-1) ?? "";
  expect(JSON.parse(profileBlock)).toEqual(alone.profile);
});
