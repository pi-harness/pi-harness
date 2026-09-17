// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ClientFile } from "../src/control-room.js";
import { GlobalSearch } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function flush(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

const files: readonly ClientFile[] = [
  { path: "README.md", status: "", label: "workspace" },
  { path: "space name.txt", status: "", label: "workspace" },
  { path: "src/app.ts", status: "M", label: "modified" },
  { path: "src/new.ts", status: "??", label: "untracked" },
];

const nativeValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

// React ignores a value it wrote itself, so the native setter plus an input event is what a keystroke looks like from here.
async function search(query: string): Promise<readonly string[]> {
  const field = document.querySelector<HTMLInputElement>(".global-search-dialog input");
  if (field === null) throw new Error("global search input is not mounted");
  await flush(() => {
    nativeValueDescriptor?.set?.call(field, query);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return [...document.querySelectorAll("#global-search-results [role='option'] strong")].map((node) => node.textContent ?? "");
}

let root: Root;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await flush(() =>
    root.render(
      createElement(GlobalSearch, {
        commands: [],
        sessions: [],
        files,
        onClose: () => {},
        onUse: () => {},
        onOpenSession: () => {},
        onOpenFile: () => {},
      }),
    ),
  );
});

afterEach(async () => {
  await flush(() => root.unmount());
  document.body.replaceChildren();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

// Global search is a search, not a reference: the gateway labels each changed file with how Git sees it, and those words are how a reader asks for that set.
test("finds a changed file by the word describing the change", async () => {
  expect(await search("modified")).toEqual(["src/app.ts"]);
  expect(await search("untracked")).toEqual(["src/new.ts"]);
  expect(await search("??")).toEqual(["src/new.ts"]);
});

// The catalogue label is the same word on every indexed file, so matching it — or any substring of it, "spa" among them — answered for the whole index instead of for the file being looked for.
test("does not let the constant workspace label answer for the whole index", async () => {
  expect(await search("spa")).toEqual(["space name.txt"]);
  expect(await search("workspace")).toEqual([]);
  expect(await search("app")).toEqual(["src/app.ts"]);
});
