// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientSessionList, type ClientMarketplacePage } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { ControlRoomView } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}
let root: Root;
let locale: ReturnType<typeof activeLocale>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const listing = (name: string): ClientSessionList => ({
  items: [{ name, sessionId: name, path: `/sessions/${name}.jsonl`, messageCount: 1 }],
  total: 1,
  page: 0,
  pageSize: 30,
  hasNext: false,
});
const marketplace: ClientMarketplacePage = { items: [], total: 0, page: 0, pageSize: 24, hasNext: false, capabilities: [], categories: [] };
function apiWith(sessions: Promise<ClientSessionList>, market: Promise<ClientMarketplacePage>): ClientApi {
  return {
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
    listSessions: () => sessions,
    listMarketplace: () => market,
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
test("renders session results without waiting for marketplace and keeps them when an older batch completes", async () => {
  const oldMarket = deferred<ClientMarketplacePage>();
  await flush(() => root.render(createElement(ControlRoomView, { api: apiWith(Promise.resolve(listing("Earlier task")), oldMarket.promise) })));
  expect(document.querySelector("aside")?.textContent).toContain("Earlier task");
  const newMarket = deferred<ClientMarketplacePage>();
  await flush(() => root.render(createElement(ControlRoomView, { api: apiWith(Promise.resolve(listing("Latest task")), newMarket.promise) })));
  expect(document.querySelector("aside")?.textContent).toContain("Latest task");
  await flush(() => oldMarket.resolve(marketplace));
  expect(document.querySelector("aside")?.textContent).toContain("Latest task");
  expect(document.querySelector("aside")?.textContent).not.toContain("Earlier task");
  await flush(() => newMarket.resolve(marketplace));
});
test("ignores a late session result after a newer refresh and reports failures before marketplace completes", async () => {
  const oldSessions = deferred<ClientSessionList>();
  const oldMarket = deferred<ClientMarketplacePage>();
  await flush(() => root.render(createElement(ControlRoomView, { api: apiWith(oldSessions.promise, oldMarket.promise) })));
  const newMarket = deferred<ClientMarketplacePage>();
  await flush(() => root.render(createElement(ControlRoomView, { api: apiWith(Promise.resolve(listing("Latest task")), newMarket.promise) })));
  await flush(() => oldSessions.resolve(listing("Stale task")));
  expect(document.querySelector("aside")?.textContent).toContain("Latest task");
  expect(document.querySelector("aside")?.textContent).not.toContain("Stale task");
  const failed = deferred<ClientSessionList>();
  await flush(() => root.render(createElement(ControlRoomView, { api: apiWith(failed.promise, newMarket.promise) })));
  await flush(() => failed.reject(new Error("offline")));
  expect(document.body.textContent).toContain("Session list");
  await flush(() => root.render(createElement(ControlRoomView, { api: apiWith(Promise.resolve(listing("Recovered task")), newMarket.promise) })));
  expect(document.querySelector("aside")?.textContent).toContain("Recovered task");
  expect(document.querySelector(".refresh-warning")).toBeNull();
  await flush(() => {
    oldMarket.resolve(marketplace);
    newMarket.resolve(marketplace);
  });
});

test("shows the conversation once runtime reads finish while marketplace is still pending", async () => {
  const market = deferred<ClientMarketplacePage>();
  await flush(() => root.render(createElement(ControlRoomView, { api: apiWith(Promise.resolve(listing("Product task")), market.promise) })));
  expect(document.querySelector(".initial-loading")).toBeNull();
  expect(document.querySelector('textarea[aria-label="Prompt"]')).not.toBeNull();
  await flush(() => market.resolve(marketplace));
});

test("ends initial waiting and exposes retry when session loading fails before the catalog", async () => {
  const market = deferred<ClientMarketplacePage>();
  const session = deferred<Awaited<ReturnType<ClientApi["getSession"]>>>();
  const api = { ...apiWith(Promise.resolve(listing("Product task")), market.promise), getSession: () => session.promise };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  await flush(() => session.reject(new Error("offline")));
  expect(document.querySelector(".initial-loading")).toBeNull();
  expect(document.querySelector(".refresh-warning")?.textContent).toContain("Current session");
  expect(document.querySelector(".refresh-warning button")?.textContent).toBe("Retry");
  await flush(() => root.render(createElement(ControlRoomView, { api: apiWith(Promise.resolve(listing("Product task")), market.promise) })));
  expect(document.querySelector(".refresh-warning")).toBeNull();
  await flush(() => market.resolve(marketplace));
});

test("allows two consecutive session switches while marketplace refreshes remain pending", async () => {
  const market = deferred<ClientMarketplacePage>();
  let current = { sessionId: "active", sessionFile: "/sessions/active.jsonl", messages: [], entries: [], events: [] };
  const openSession = vi.fn((path: string) => {
    current = { ...current, sessionId: path, sessionFile: path };
    return Promise.resolve(current);
  });
  const sessions = { ...listing("Alpha"), items: [...listing("Alpha").items, ...listing("Beta").items], total: 2 };
  const api = { ...apiWith(Promise.resolve(sessions), market.promise), getSession: () => Promise.resolve(current), openSession };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  const clickSession = (name: string) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("aside button")).find((item) => item.textContent?.startsWith(name));
    expect(button).toBeDefined();
    button?.click();
  };
  await flush(() => clickSession("Alpha"));
  expect(openSession).toHaveBeenCalledWith("/sessions/Alpha.jsonl");
  await flush(() => clickSession("Beta"));
  expect(openSession).toHaveBeenCalledWith("/sessions/Beta.jsonl");
  expect(current.sessionFile).toBe("/sessions/Beta.jsonl");
  await flush(() => market.resolve(marketplace));
  expect(current.sessionFile).toBe("/sessions/Beta.jsonl");
});

test("loads models and installed plugins before marketplace and preserves newer independent results", async () => {
  const oldMarket = deferred<ClientMarketplacePage>();
  const model = { provider: "test", id: "model", name: "Production model", reasoning: false, contextWindow: 128000, active: true };
  const plugin = { id: "example", name: "Example plugin", enabled: true, state: "active", removable: true };
  const api = {
    ...apiWith(Promise.resolve(listing("Product task")), oldMarket.promise),
    listModels: () => Promise.resolve([model]),
    listPlugins: () => Promise.resolve([plugin]),
  };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  expect(document.querySelector('select[aria-label="Models"] option[value="test/model"]')).not.toBeNull();
  expect(document.querySelector('button[aria-label="plugins, 1 installed"]')).not.toBeNull();
  const newMarket = deferred<ClientMarketplacePage>();
  await flush(() =>
    root.render(
      createElement(ControlRoomView, {
        api: { ...api, listModels: () => Promise.resolve([{ ...model, id: "new-model" }]), listMarketplace: () => newMarket.promise },
      }),
    ),
  );
  await flush(() => oldMarket.resolve(marketplace));
  expect(document.querySelector('select[aria-label="Models"] option[value="test/new-model"]')).not.toBeNull();
  expect(document.querySelector('select[aria-label="Models"] option[value="test/model"]')).toBeNull();
  await flush(() => newMarket.resolve(marketplace));
});

test("clears recovered resource errors after switching language while marketplace is pending", async () => {
  const market = deferred<ClientMarketplacePage>();
  const files = deferred<Awaited<ReturnType<ClientApi["getFiles"]>>>();
  const api = { ...apiWith(Promise.resolve(listing("Product task")), market.promise), getFiles: () => files.promise };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  await flush(() => files.reject(new Error("offline")));
  expect(document.querySelector(".refresh-warning")?.textContent).toContain("Files");
  await act(async () => {
    await setLocale("zh-CN");
  });
  await flush(() => root.render(createElement(ControlRoomView, { api: { ...api, getFiles: () => Promise.resolve({ items: [], repository: false }) } })));
  expect(document.querySelector(".refresh-warning")).toBeNull();
  await flush(() => market.resolve(marketplace));
});

test.each(["accepted", "rejected"] as const)("blocks stale session actions until navigation is %s", async (outcome) => {
  const opening = deferred<Awaited<ReturnType<ClientApi["getSession"]>>>();
  let current = { sessionId: "active", sessionFile: "/sessions/active.jsonl", name: "Original", messages: [], entries: [], events: [] };
  const api = {
    ...apiWith(Promise.resolve(listing("Alpha")), Promise.resolve(marketplace)),
    getSession: () => Promise.resolve(current),
    openSession: () => opening.promise,
  };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  const actions = () => document.querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')!;
  await flush(() => actions().click());
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await flush(() => {
    Array.from(document.querySelectorAll<HTMLButtonElement>("aside button"))
      .find((item) => item.textContent?.startsWith("Alpha"))!
      .click();
  });
  expect(new URL(window.location.href).searchParams.get("session")).toBe("/sessions/Alpha.jsonl");
  expect(actions().disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Session tools"]')!.disabled).toBe(true);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await flush(() => {
    if (outcome === "accepted") {
      current = { ...current, sessionId: "Alpha", sessionFile: "/sessions/Alpha.jsonl", name: "Alpha" };
      opening.resolve(current);
    } else opening.reject(new Error("Switch canceled"));
  });
  expect(actions().disabled).toBe(false);
  await flush(() => actions().click());
  await flush(() => {
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.startsWith("Rename"))!
      .click();
  });
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe(outcome === "accepted" ? "Alpha" : "Original");
});

test("closes an existing rename dialog when browser history changes the session", async () => {
  const opening = deferred<Awaited<ReturnType<ClientApi["getSession"]>>>();
  const current = { sessionId: "active", sessionFile: "/sessions/active.jsonl", name: "Original", messages: [], entries: [], events: [] };
  const api = {
    ...apiWith(Promise.resolve(listing("Alpha")), Promise.resolve(marketplace)),
    getSession: () => Promise.resolve(current),
    openSession: () => opening.promise,
  };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  await flush(() => document.querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')!.click());
  await flush(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.startsWith("Rename"))!
      .click(),
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await flush(() => {
    window.history.pushState({}, "", "/?session=/sessions/Alpha.jsonl");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')!.disabled).toBe(true);
  await flush(() => opening.reject(new Error("Switch canceled")));
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')!.disabled).toBe(false);
});

test("uses the accepted session during initial URL restoration even when the follow-up read fails", async () => {
  window.history.replaceState({}, "", "/?session=/sessions/Alpha.jsonl");
  const original = { sessionId: "active", sessionFile: "/sessions/active.jsonl", name: "Original", messages: [], entries: [], events: [] };
  const target = { ...original, sessionId: "Alpha", sessionFile: "/sessions/Alpha.jsonl", name: "Alpha" };
  let opened = false;
  const api = {
    ...apiWith(Promise.resolve(listing("Alpha")), Promise.resolve(marketplace)),
    getSession: () => (opened ? Promise.reject(new Error("Read unavailable")) : Promise.resolve(original)),
    openSession: () => {
      opened = true;
      return Promise.resolve(target);
    },
  };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  expect(opened).toBe(true);
  const actions = document.querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')!;
  expect(actions.disabled).toBe(false);
  await flush(() => actions.click());
  await flush(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.startsWith("Rename"))!
      .click(),
  );
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe("Alpha");
});

test.each([true, false])("shows model waiting after the last parallel tool ends (starts observed: %s)", async (startsObserved) => {
  let emit: Parameters<ClientApi["subscribeEvents"]>[0] = () => {};
  const base = apiWith(Promise.resolve(listing("Alpha")), Promise.resolve(marketplace));
  const api = {
    ...base,
    getStatus: async () => ({ ...(await base.getStatus()), status: "running" as const }),
    subscribeEvents: (listener: typeof emit) => {
      emit = listener;
      return () => {};
    },
  };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  const event = (type: string, toolCallId?: string, runPhase?: string) => emit({ type: "event", event: { type, toolCallId, runPhase } });
  await flush(() => {
    event("agent_start");
    if (startsObserved) {
      event("tool_execution_start", "one");
      event("tool_execution_start", "two");
    }
  });
  if (startsObserved) expect(document.body.textContent).toContain("Tool running");
  await flush(() => event("tool_execution_end", "one", "tool"));
  expect(document.body.textContent).toContain("Tool running");
  await flush(() => event("tool_execution_end", "two", "starting"));
  expect(document.body.textContent).toContain("Waiting for model");
  expect(document.body.textContent).not.toContain("Tool running");
});

test("renders active compaction after reconnect, protects drafts, and keeps Stop available", async () => {
  const base = apiWith(Promise.resolve(listing("Alpha")), Promise.resolve(marketplace));
  const abort = vi.fn(() => Promise.resolve({ aborted: true }));
  const prompt = vi.fn();
  const api = {
    ...base,
    abort,
    prompt,
    getStatus: async () => ({
      ...(await base.getStatus()),
      status: "running",
      run: { phase: "compacting" as const, startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() },
    }),
  };
  await flush(() => root.render(createElement(ControlRoomView, { api })));
  expect(document.body.textContent).toContain("Compacting");
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')!.disabled).toBe(true);
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!;
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Preserve this draft");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
  await flush(() => textarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(prompt).not.toHaveBeenCalled();
  expect(textarea.value).toBe("Preserve this draft");
  const stop = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "Stop")!;
  expect(stop.disabled).toBe(false);
  await flush(() => stop.click());
  expect(abort).toHaveBeenCalledOnce();
});
