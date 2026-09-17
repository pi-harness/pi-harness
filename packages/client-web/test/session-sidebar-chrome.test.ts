// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientSessionList } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { ControlRoomView, scrollInvalidatesSessionPopover } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const sessionIds = ["alpha", "beta", "gamma"] as const;
// A real poll parses its own array out of the response, so every call has to hand back a new one: a shared literal would give the list a stable identity no HTTP response ever has, and hide anything keyed on it.
const listing = (): ClientSessionList => ({
  items: sessionIds.map((id) => ({ name: `Task ${id}`, sessionId: id, path: `/sessions/${id}.jsonl`, messageCount: 2 })),
  total: sessionIds.length,
  page: 0,
  pageSize: 30,
  hasNext: false,
});
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
    listSessions: () => Promise.resolve(listing()),
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

// The transcript sticks itself to the bottom through the same prototype method, so only the calls made on a session row say anything about the sidebar.
const rowScrolls = (scrollIntoView: ReturnType<typeof vi.fn>): number =>
  scrollIntoView.mock.instances.filter((instance) => instance instanceof HTMLElement && instance.classList.contains("session-row")).length;

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
  vi.useRealTimers();
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

test("distinguishes a scroll of the trigger's own container from every other scroll on the page", () => {
  const container = document.createElement("div");
  const trigger = document.createElement("button");
  container.append(trigger);
  const elsewhere = document.createElement("div");
  document.body.append(container, elsewhere);

  expect(scrollInvalidatesSessionPopover(container, trigger)).toBe(true);
  expect(scrollInvalidatesSessionPopover(trigger, trigger)).toBe(true);
  expect(scrollInvalidatesSessionPopover(elsewhere, trigger)).toBe(false);
  // With no trigger to measure against, a target that is not a node at all, or a scroll of the page itself, there is nothing left to prove the popover still lines up, so it goes.
  expect(scrollInvalidatesSessionPopover(container, null)).toBe(true);
  expect(scrollInvalidatesSessionPopover(window, trigger)).toBe(true);
  expect(scrollInvalidatesSessionPopover(document, trigger)).toBe(true);
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

test("presents one control per session in selection mode, not a row and a box that both toggle it", async () => {
  await flush(() => root.render(createElement(ControlRoomView, { api: api("alpha") })));
  await flush(() => button('[aria-pressed="false"].session-tool-button').click());

  const rows = [...document.querySelectorAll(".session-row-wrap")];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    // Exactly one thing in the row reaches the accessibility tree as a checkbox, and it is the row button, which carries the session's own name.
    expect(row.querySelectorAll('[role="checkbox"]').length).toBe(1);
    expect(row.querySelector('[role="checkbox"]')?.classList.contains("session-row")).toBe(true);
    const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect([box?.getAttribute("aria-hidden"), box?.tabIndex]).toEqual(["true", -1]);
  }

  // The tick is still a tick: clicking it selects, it just does not announce itself a second time.
  const box = rows[1]?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  await flush(() => box?.click());
  expect(rows[1]?.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
});

test("scrolls the active session row into view when the session changes", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView, writable: true });
  await flush(() => root.render(createElement(ControlRoomView, { api: api("alpha") })));
  scrollIntoView.mockClear();
  await flush(() => root.render(createElement(ControlRoomView, { api: api("gamma") })));
  expect(rowScrolls(scrollIntoView)).toBeGreaterThan(0);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
});

// Polling is the sidebar's normal state, not an edge case: the list is replaced every five seconds whether or not anything in it moved, and a user reading older sessions is scrolled away from the active row the whole time.
test("leaves the sidebar where the user put it while polls keep replacing the session list", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView, writable: true });
  vi.useFakeTimers();
  await flush(() => root.render(createElement(ControlRoomView, { api: api("alpha") })));
  expect(rowScrolls(scrollIntoView)).toBe(1);

  scrollIntoView.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(rowScrolls(scrollIntoView)).toBe(0);
});
