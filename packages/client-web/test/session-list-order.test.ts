// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientSessionList } from "../src/control-room.js";
import { ControlRoomView, sessionGroups } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const marketplace: ClientMarketplacePage = { items: [], total: 0, page: 0, pageSize: 24, hasNext: false, capabilities: [], categories: [] };

const toolEntries = [
  {
    type: "message",
    timestamp: "2026-09-17T12:56:21.936Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
  },
  {
    type: "message",
    timestamp: "2026-09-17T12:56:22.000Z",
    message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "/workspace" }], isError: false },
  },
];

function api(
  items: readonly Record<string, unknown>[],
  active: { sessionId: string; sessionFile: string },
  overrides: Partial<ClientApi> = {},
  entries: readonly Record<string, unknown>[] = [],
): ClientApi {
  const listing = (): ClientSessionList => ({ items: items.map((item) => ({ ...item })), total: items.length, page: 0, pageSize: 30, hasNext: false });
  return {
    ...createClientApi(),
    getStatus: () =>
      Promise.resolve({
        status: "ready",
        model: "test/model",
        messages: 2,
        // The gateway reports the size of its own process-wide event buffer here, and that buffer is emptied whenever a session is opened.
        events: 0,
        sessionId: active.sessionId,
        sessionFile: active.sessionFile,
        cwd: "/workspace",
        agentDir: "/sessions",
        plugins: [],
      }),
    getSession: () => Promise.resolve({ ...active, messages: [], entries: entries.map((entry) => ({ ...entry })), events: [] }),
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
    ...overrides,
  };
}

let root: Root;

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, "", "/");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await flush(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("session grouping", () => {
  const today = new Date().toISOString();
  const lastWeek = "2026-09-10T01:00:04.000Z";

  // The server already returns pinned sessions first; the sidebar re-bucketed them by date and painted "today" before "earlier", so a session pinned last week sat below every unpinned one from today.
  test("keeps a pinned session above the date buckets however old it is", () => {
    const groups = sessionGroups([
      { path: "/sessions/fresh.jsonl", modified: today },
      { path: "/sessions/pinned.jsonl", modified: lastWeek, pinned: true },
    ]);

    expect(groups.map(([id, sessions]) => [id, sessions.map((session) => session.path)])).toEqual([
      ["pinned", ["/sessions/pinned.jsonl"]],
      ["today", ["/sessions/fresh.jsonl"]],
    ]);
  });

  // A duplicate copies its source's messages verbatim, and Pi reads `modified` off the last message, so a copy made today reports the source's activity time and files itself under a stale date.
  test("buckets a duplicate by the recency the server computed, not by the transcript it copied", () => {
    const groups = sessionGroups([{ path: "/sessions/fork.jsonl", created: today, modified: lastWeek, recency: today }]);

    expect(groups.map(([id]) => id)).toEqual(["today"]);
  });

  test("still falls back to the modified time for a session the server did not date", () => {
    const groups = sessionGroups([{ path: "/sessions/plain.jsonl", modified: lastWeek }]);

    expect(groups.map(([id]) => id)).toEqual(["earlier"]);
  });
});

describe("session sidebar rows", () => {
  test("renders the pinned group first in the sidebar", async () => {
    const sessions = [
      { name: "Fresh task", sessionId: "fresh", path: "/sessions/fresh.jsonl", messageCount: 2, modified: new Date().toISOString() },
      { name: "Pinned task", sessionId: "pinned", path: "/sessions/pinned.jsonl", messageCount: 2, modified: "2026-09-10T01:00:04.000Z", pinned: true },
    ];
    await flush(() => root.render(createElement(ControlRoomView, { api: api(sessions, { sessionId: "fresh", sessionFile: "/sessions/fresh.jsonl" }) })));

    const groups = [...document.querySelectorAll(".session-group")];
    expect(groups[0]?.querySelector(".group-label")?.textContent).toBe("已置顶");
    expect(groups[0]?.querySelector(".session-row")?.textContent).toContain("Pinned task");
  });

  // A truncated session file keeps the id of the session it was cut from, so two rows claimed to be the open one and both drew the selected border.
  test("marks exactly one row as the open session when two files share an id", async () => {
    const sessions = [
      { name: "Intact", sessionId: "shared", path: "/sessions/intact.jsonl", messageCount: 2, modified: new Date().toISOString() },
      { name: "Truncated copy", sessionId: "shared", path: "/sessions/truncated.jsonl", messageCount: 0, modified: new Date().toISOString() },
    ];
    await flush(() => root.render(createElement(ControlRoomView, { api: api(sessions, { sessionId: "shared", sessionFile: "/sessions/intact.jsonl" }) })));

    const active = [...document.querySelectorAll('.session-row[aria-current="true"]')];
    expect(active).toHaveLength(1);
    expect(active[0]?.textContent).toContain("Intact");
    expect(document.querySelectorAll(".session-row.active")).toHaveLength(1);
  });
});

describe("live context metrics", () => {
  // /api/status counts the gateway's global buffer, which is empty after a restart, so a reopened session read 0 events beside a Trace tab listing 2.
  test("counts the session's own trace rather than the server's event buffer", async () => {
    const sessions = [{ name: "Reopened", sessionId: "reopened", path: "/sessions/reopened.jsonl", messageCount: 2, modified: new Date().toISOString() }];
    await flush(() =>
      root.render(createElement(ControlRoomView, { api: api(sessions, { sessionId: "reopened", sessionFile: "/sessions/reopened.jsonl" }, {}, toolEntries) })),
    );

    expect(document.querySelector(".context-metrics")?.textContent).toContain("2 个事件");
  });
});

describe("failed session actions", () => {
  test("shows the reason inside the dialog that is still holding focus", async () => {
    const sessions = [{ name: "Task alpha", sessionId: "alpha", path: "/sessions/alpha.jsonl", messageCount: 2, modified: new Date().toISOString() }];
    const renameSession = vi.fn(() => Promise.reject(new Error("Session name must be at most 120 characters")));
    await flush(() =>
      root.render(
        createElement(ControlRoomView, {
          api: api(sessions, { sessionId: "alpha", sessionFile: "/sessions/alpha.jsonl" }, { renameSession }),
        }),
      ),
    );

    await flush(() => document.querySelector<HTMLButtonElement>('[aria-label="会话操作 Task alpha"]')?.click());
    const rename = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "重命名");
    await flush(() => rename?.click());
    const dialog = document.querySelector(".session-dialog");
    expect(dialog).not.toBeNull();
    // The server refuses a name past 120 characters, and the field now stops there rather than collecting one the request will bounce.
    expect(dialog?.querySelector("input")?.getAttribute("maxlength")).toBe("120");

    const save = [...document.querySelectorAll<HTMLButtonElement>(".session-dialog-actions button")].find((button) => button.textContent === "保存名称");
    await flush(() => save?.click());
    await flush(() => {});

    expect(renameSession).toHaveBeenCalled();
    expect(document.querySelector(".session-dialog")).not.toBeNull();
    expect(document.querySelector(".session-dialog .session-dialog-error")?.textContent).toContain("Session name must be at most 120 characters");
  });
});
