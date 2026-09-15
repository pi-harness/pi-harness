// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeLocale, setLocale } from "../src/i18n.js";
import { Details } from "../src/react-room.js";

const reactTestEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function DetailsHarness({ invoker }: { invoker: HTMLElement }) {
  const [open, setOpen] = useState(true);
  return open
    ? createElement(Details, {
        event: { type: "file_diff", path: "src/app.ts", output: "+fixed" },
        onClose: () => setOpen(false),
        onCopy: () => {},
        returnFocusTarget: invoker,
      })
    : null;
}

let root: Root | undefined;
let previousLocale: ReturnType<typeof activeLocale>;

beforeEach(async () => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  previousLocale = activeLocale();
  await setLocale("en");
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
  let frame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(performance.now());
    return ++frame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await setLocale(previousLocale);
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

test("traps focus in file details and restores the explicit invoker on Escape", () => {
  const invoker = document.createElement("button");
  invoker.textContent = "View diff";
  const previouslyFocused = document.createElement("button");
  previouslyFocused.textContent = "Other control";
  const container = document.createElement("div");
  document.body.append(invoker, previouslyFocused, container);
  previouslyFocused.focus();

  root = createRoot(container);
  act(() => root?.render(createElement(DetailsHarness, { invoker })));

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close file diff"]');
  const last = dialog?.querySelector<HTMLElement>("summary");
  expect(dialog?.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(close);

  last?.focus();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  expect(document.activeElement).toBe(close);

  close?.focus();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
  expect(document.activeElement).toBe(last);

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(invoker);
});
