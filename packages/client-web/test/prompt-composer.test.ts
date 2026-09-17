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
    getWorkspaceFiles: () =>
      Promise.resolve({
        items: [
          { path: "README.md", label: "workspace", status: "" },
          { path: "space name.txt", label: "workspace", status: "" },
          { path: "src/calc.js", label: "workspace", status: "" },
        ],
        truncated: false,
      }),
    listModels: () => Promise.resolve([]),
    listProviders: () => Promise.resolve([]),
    listPlugins: () => Promise.resolve([]),
    listPluginPanels: () => Promise.resolve([]),
    listCommands: () => Promise.resolve([{ name: "plan", invocationName: "plan", description: "Draft a plan" }]),
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
const setNativeValue = (field: HTMLTextAreaElement, value: string): void => {
  nativeValueDescriptor?.set?.call(field, value);
};

// React tracks the last value it wrote, so a test that assigns through the React-patched setter is ignored as a no-op change. The native setter plus an input event is the same pair a keystroke produces.
async function type(value: string, caret = value.length): Promise<void> {
  const field = composer();
  await flush(() => {
    setNativeValue(field, value);
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function moveCaret(caret: number): Promise<void> {
  const field = composer();
  await flush(() => {
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Home" }));
  });
}

async function press(key: string): Promise<boolean> {
  const field = composer();
  let defaultPrevented = false;
  await flush(() => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
    field.dispatchEvent(event);
    defaultPrevented = event.defaultPrevented;
  });
  return defaultPrevented;
}

const options = (): readonly string[] => [...document.querySelectorAll("#prompt-completion-list [role='option'] strong")].map((node) => node.textContent ?? "");

let root: Root;
let locale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  // Every request the console makes in these tests is answered by the stub api; anything that still reaches the network is a real connection attempt from a test machine that has no server on the other end.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  locale = activeLocale();
  await setLocale("en");
  window.history.replaceState({}, "", "/");
  window.sessionStorage.clear();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await flush(() => root.render(createElement(ControlRoomView, { api: api() })));
  await flush(() => {});
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

// The runtime expands a command only when the prompt begins with one. Offered at any caret, the list advertised commands that would have been sent to the model as prose and paid for as chat.
test("offers commands only where the runtime would run one, and files anywhere", async () => {
  await type("fix the bug /pl");
  expect(document.querySelector("#prompt-completion-list")).toBeNull();

  await type("/pl");
  expect(options()).toEqual(["/plan"]);

  await type("fix @calc");
  expect(options()).toEqual(["@src/calc.js"]);
});

// The @ picker matched the constant label every indexed file carries, so "workspace" matched the whole index and unrelated files outranked the one being typed — and the first option is what Enter accepts.
test("ranks the file being typed first instead of one whose label happens to match", async () => {
  await type("look at @spa");
  expect(options()).toEqual(["@space name.txt"]);

  await type("look at @workspace");
  expect(options()).toEqual([]);
});

// The popover read a caret that only a keystroke updated, so moving the caret left the list open over a token no longer under it, and Enter sent the half-typed prompt instead of accepting the highlighted item.
test("closes the completion list when the caret leaves the token it belongs to", async () => {
  await type("hi @cal");
  expect(options()).toEqual(["@src/calc.js"]);
  expect(composer().getAttribute("aria-expanded")).toBe("true");

  await moveCaret(0);

  expect(document.querySelector("#prompt-completion-list")).toBeNull();
  expect(composer().getAttribute("aria-expanded")).toBe("false");
  // With no list under the caret, Enter belongs to the form again.
  expect(await press("Enter")).toBe(true);
});

// A query that matches nothing is exactly when the reader needs to be told so; the branch that says it could never render because the popover was gated on having items.
test("says so when the typed path matches nothing, and still lets Enter send the prompt", async () => {
  await type("look at @nonexistent");

  expect(document.querySelector("#prompt-completion-list")).not.toBeNull();
  expect(document.querySelector(".prompt-completion-empty")?.textContent).toMatch(/\S/u);
  expect(options()).toEqual([]);
  expect(composer().getAttribute("aria-activedescendant")).toBeNull();
  expect(await press("Enter")).toBe(true);
});

// The chip writes characters the user did not type, and dismissing its list used to leave them behind: a bare "/" that the runtime then routes as an unknown command.
test("takes back the slash the Commands chip wrote when the list is dismissed", async () => {
  await type("fix the bug");
  const chip = document.querySelector<HTMLButtonElement>(".composer-tools .tool-chip");
  expect(chip?.disabled).toBe(false);

  await flush(() => chip?.click());
  // The command has to lead the prompt for the runtime to run it at all, so the chip writes the slash at the front rather than at the caret.
  expect(composer().value).toBe("/ fix the bug");
  expect(options()).toEqual(["/plan"]);

  await press("Escape");
  expect(composer().value).toBe("fix the bug");
  expect(document.querySelector("#prompt-completion-list")).toBeNull();
});

test("leaves a slash the user typed alone when the list is dismissed", async () => {
  await type("/pl");
  expect(options()).toEqual(["/plan"]);

  await press("Escape");
  expect(composer().value).toBe("/pl");
  expect(document.querySelector("#prompt-completion-list")).toBeNull();
});
