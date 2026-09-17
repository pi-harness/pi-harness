// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClientApi, type ClientApi, type ClientMarketplacePage, type ClientStatus } from "../src/control-room.js";
import { activeLocale, setLocale } from "../src/i18n.js";
import { maxStoredPromptDraftCharacters, writeStoredPromptDraft } from "../src/prompt-ui.js";
import { ControlRoomView } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const marketplace: ClientMarketplacePage = { items: [], total: 0, page: 0, pageSize: 24, hasNext: false, capabilities: [], categories: [] };

const readyStatus = (): ClientStatus => ({
  status: "ready",
  model: "test/model",
  messages: 0,
  events: 0,
  sessionId: "alpha",
  sessionFile: "/sessions/alpha.jsonl",
  cwd: "/workspace",
  agentDir: "/sessions",
  plugins: [],
});

function api(): ClientApi {
  return {
    ...createClientApi(),
    getStatus: () => Promise.resolve(readyStatus()),
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

const composer = (): HTMLTextAreaElement => {
  const field = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (field === null) throw new Error("composer textarea is not mounted");
  return field;
};

const nativeValueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  locale = activeLocale();
  await setLocale("en");
  window.history.replaceState({}, "", "/");
  window.sessionStorage.clear();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await flush(() => root.unmount());
  document.body.replaceChildren();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await setLocale(locale);
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

// A draft past the storage cap comes back shortened. Presenting the beginning as the whole thing leaves the writer looking at a prompt that stops mid-sentence with nothing to explain it, so the restore says what it kept.
test("says so when the restored draft is only the beginning of what was written", async () => {
  writeStoredPromptDraft(window.sessionStorage, "alpha", "y".repeat(maxStoredPromptDraftCharacters + 2_000));

  await flush(() => root.render(createElement(ControlRoomView, { api: api() })));
  await flush(() => {});

  expect(composer().value.length).toBe(maxStoredPromptDraftCharacters);
  expect(document.querySelector(".composer-overflow")?.textContent).toBe(
    `Only the first ${maxStoredPromptDraftCharacters.toLocaleString("en")} characters of the draft were restored after the reload; the rest was never saved`,
  );

  // Once the writer has edited what came back, the composer holds what they meant it to hold and the notice no longer describes it.
  await flush(() => {
    const field = composer();
    nativeValueDescriptor?.set?.call(field, "a shorter draft");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(document.querySelector(".composer-overflow")).toBeNull();
});

test("restores a draft that fitted without claiming anything was lost", async () => {
  writeStoredPromptDraft(window.sessionStorage, "alpha", "the whole draft");

  await flush(() => root.render(createElement(ControlRoomView, { api: api() })));
  await flush(() => {});

  expect(composer().value).toBe("the whole draft");
  expect(document.querySelector(".composer-overflow")).toBeNull();
});
