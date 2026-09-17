// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientSessionList } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { ControlRoomView } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const sessionIds = ["alpha", "beta", "gamma"] as const;
const listing: ClientSessionList = {
  items: sessionIds.map((id) => ({ name: `Task ${id}`, sessionId: id, path: `/sessions/${id}.jsonl`, messageCount: 2 })),
  total: sessionIds.length,
  page: 0,
  pageSize: 30,
  hasNext: false,
};
const marketplace: ClientMarketplacePage = { items: [], total: 0, page: 0, pageSize: 24, hasNext: false, capabilities: [], categories: [] };

function api(activeSessionId: string): ClientApi {
  return {
    ...createClientApi(),
    getStatus: () =>
      Promise.resolve({
        status: "ready",
        model: "test/model",
        messages: 2,
        events: 0,
        sessionId: activeSessionId,
        sessionFile: `/sessions/${activeSessionId}.jsonl`,
        cwd: "/workspace",
        agentDir: "/sessions",
        plugins: [],
      }),
    getSession: () => Promise.resolve({ sessionId: activeSessionId, sessionFile: `/sessions/${activeSessionId}.jsonl`, messages: [], entries: [], events: [] }),
    listSessions: () => Promise.resolve(listing),
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
}

const button = (selector: string): HTMLButtonElement => {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`no button matched ${selector}`);
  return element;
};

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  locale = activeLocale();
  await setLocale("en");
  window.history.replaceState({}, "", "/");
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
});

test("keeps an open session menu while the transcript auto-scrolls and closes it when the sidebar moves", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api: api("alpha") })));
  await flush(() => button('[aria-label="Session action Task beta"]').click());
  expect(document.querySelector(".session-row-menu-popover")).not.toBeNull();

  const transcript = document.querySelector(".chat-scroll");
  expect(transcript).not.toBeNull();
  await flush(() => transcript?.dispatchEvent(new Event("scroll", { bubbles: false })));
  expect(document.querySelector(".session-row-menu-popover")).not.toBeNull();

  const sidebar = document.querySelector(".sidebar-scroll");
  expect(sidebar).not.toBeNull();
  await flush(() => sidebar?.dispatchEvent(new Event("scroll", { bubbles: false })));
  expect(document.querySelector(".session-row-menu-popover")).toBeNull();
});

test("still drops an open session menu when the viewport resizes under it", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api: api("alpha") })));
  await flush(() => button('[aria-label="Session action Task beta"]').click());
  expect(document.querySelector(".session-row-menu-popover")).not.toBeNull();
  await flush(() => window.dispatchEvent(new Event("resize")));
  expect(document.querySelector(".session-row-menu-popover")).toBeNull();
});

test("ticks a session row in selection mode instead of opening it", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api: api("alpha") })));
  await flush(() => button('[aria-pressed="false"].session-tool-button').click());
  const rows = [...document.querySelectorAll<HTMLButtonElement>(".session-row")];
  const beta = rows.find((candidate) => candidate.textContent?.includes("Task beta"));
  expect(beta?.getAttribute("role")).toBe("checkbox");
  expect(beta?.getAttribute("aria-checked")).toBe("false");

  await flush(() => beta?.click());
  expect(beta?.getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector(".session-batch-bar")).not.toBeNull();
  // Ticking must not navigate: the conversation that was being read is still the current one.
  expect(document.querySelector('.session-row[aria-current="true"]')?.textContent).toContain("Task alpha");
});

test("scrolls the active session row into view when the session changes", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView, writable: true });
  await flush(() => root.render(createElement(ControlRoomView, { api: api("alpha") })));
  scrollIntoView.mockClear();
  await flush(() => root.render(createElement(ControlRoomView, { api: api("gamma") })));
  const calls = scrollIntoView.mock.instances.filter((instance) => instance instanceof HTMLElement && instance.classList.contains("session-row"));
  expect(calls.length).toBeGreaterThan(0);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
});
