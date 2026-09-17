// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientStatus } from "../src/control-room.js";
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

const runningStatus = (): ClientStatus => ({
  status: "running",
  model: "test/model",
  messages: 2,
  events: 1,
  sessionId: "alpha",
  sessionFile: "/sessions/alpha.jsonl",
  cwd: "/workspace",
  agentDir: "/sessions",
  plugins: [],
  run: { startedAt: new Date(Date.now() - 30_000).toISOString(), lastActivityAt: new Date().toISOString(), phase: "responding" },
});

function api(getStatus: () => Promise<ClientStatus>, abort: ClientApi["abort"]): ClientApi {
  return {
    ...createClientApi(),
    abort,
    getStatus,
    getSession: () => Promise.resolve({ sessionId: "alpha", sessionFile: "/sessions/alpha.jsonl", messages: [], entries: [], events: [] }),
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
}

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
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await flush(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await setLocale(locale);
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

// The pill's tone is what the status polls saw; Stop is a POST that has not been sent yet. Tying one to the other took the primary abort away for a whole poll interval on a single failed request, while ⌃C and the slow-run warning's own Stop went on working. A single failed poll is not yet a verdict either: one dropped request during a long tool call, which is precisely when the event stream has nothing to say, used to be enough to tell the reader the runtime was gone.
test("waits for a second failed status poll before calling the run offline, and keeps Stop live and delivering throughout", async () => {
  let polls = 0;
  const abort = vi.fn(() => Promise.resolve({ aborted: true }));
  const getStatus = (): Promise<ClientStatus> => {
    polls += 1;
    return polls === 1 ? Promise.resolve(runningStatus()) : Promise.reject(new Error("status unreachable"));
  };
  await flush(() => root.render(createElement(ControlRoomView, { api: api(getStatus, abort) })));
  expect(document.querySelector(".run-indicator")?.className).not.toContain("offline");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(document.querySelector(".run-indicator")?.className).not.toContain("offline");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(document.querySelector(".run-indicator")?.className).toContain("offline");

  const stop = document.querySelector<HTMLButtonElement>(".stop-button");
  expect(stop?.disabled).toBe(false);
  await flush(() => stop?.click());
  expect(abort).toHaveBeenCalledOnce();
});

// A poll that fails once and succeeds next is a dropped request, and the run it was asking about never stopped answering.
test("forgets a single failed poll as soon as the next one answers", async () => {
  let polls = 0;
  const abort = vi.fn(() => Promise.resolve({ aborted: true }));
  const getStatus = (): Promise<ClientStatus> => {
    polls += 1;
    return polls === 2 || polls === 4 ? Promise.reject(new Error("status unreachable")) : Promise.resolve(runningStatus());
  };
  await flush(() => root.render(createElement(ControlRoomView, { api: api(getStatus, abort) })));

  for (let poll = 0; poll < 4; poll += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect([poll, document.querySelector(".run-indicator")?.className.includes("offline")]).toEqual([poll, false]);
  }
});
