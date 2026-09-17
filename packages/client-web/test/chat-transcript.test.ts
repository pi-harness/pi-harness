// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientSession, type ClientStatus } from "../src/control-room.js";
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

const readyStatus = (messages: number): ClientStatus => ({
  status: "ready",
  model: "test/model",
  messages,
  events: messages * 2,
  sessionId: "alpha",
  sessionFile: "/sessions/alpha.jsonl",
  cwd: "/workspace",
  agentDir: "/sessions",
  plugins: [],
});

function api(session: ClientSession): ClientApi {
  return {
    ...createClientApi(),
    getStatus: () => Promise.resolve(readyStatus(session.messages.length)),
    getSession: () => Promise.resolve(session),
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

const session = (messages: readonly Record<string, unknown>[]): ClientSession => ({
  sessionId: "alpha",
  sessionFile: "/sessions/alpha.jsonl",
  messages,
  entries: [],
  events: [],
});

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

// A slash command answers through a message the runtime marks for display. Dropped before it reached a turn, the console showed nothing at all for a command that had replied in full, while the same text sat in the model's context.
test("shows the output a command wrote into the conversation", async () => {
  const transcript = session([
    { role: "user", content: "/subagents-doctor" },
    {
      role: "custom",
      customType: "subagent-slash-result",
      display: true,
      content: "## Subagent result\n\nSubagents doctor report",
      timestamp: 1789537747845,
    },
  ]);

  await flush(() => root.render(createElement(ControlRoomView, { api: api(transcript) })));
  await flush(() => {});

  const output = document.querySelector(".chat-scroll article.custom");
  expect(output).not.toBeNull();
  expect(output?.textContent).toContain("Subagents doctor report");
  expect(document.querySelector(".chat-scroll")?.className).not.toContain("is-empty");
  expect(document.querySelector(".chat-scroll .new-session-screen")).toBeNull();
});

// Both the empty-state gate and the turn list used to count raw messages, so a history that projected to no turns suppressed the starter screen and put nothing in its place: a white pane beside a header counting the messages behind it.
test("falls back to the workspace starter when the messages project to no turns at all", async () => {
  const transcript = session([
    { role: "custom", customType: "memory", display: false, content: "context only", timestamp: 1789537747845 },
    { role: "custom", customType: "memory", display: false, content: "context only, again", timestamp: 1789537747846 },
  ]);

  await flush(() => root.render(createElement(ControlRoomView, { api: api(transcript) })));
  await flush(() => {});

  const scroll = document.querySelector(".chat-scroll");
  expect(scroll?.querySelectorAll("article")).toHaveLength(0);
  expect(scroll?.className).toContain("is-empty");
  expect(scroll?.querySelector(".new-session-screen")).not.toBeNull();
  expect(scroll?.querySelectorAll(".starter-card").length).toBeGreaterThan(0);
});
