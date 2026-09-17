// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Details, copyTextToClipboard } from "../src/react-room.js";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function renderDetails(event: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(Details, { event, onClose: () => {}, onCopy: () => Promise.resolve(true) }));
}

let root: Root | undefined;

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
  let frame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(performance.now());
    return ++frame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("event detail stats", () => {
  // A failed read and five successful bash calls reached this panel with the same four stats, while the transcript had said "Failed" about that read all along.
  test("says whether a tool call succeeded or failed", () => {
    expect(renderDetails({ type: "tool_execution_end", toolName: "read", isError: true, durationMs: 30 })).toContain("失败");
    expect(renderDetails({ type: "tool_execution_end", toolName: "bash", isError: false, durationMs: 44 })).toContain("成功");
  });

  test("reports no outcome for an event that has none", () => {
    const html = renderDetails({ type: "turn_start" });

    expect(html).not.toContain("成功");
    expect(html).not.toContain("失败");
  });

  // The panel used to print "耗时 6.1 s" for a 40 ms call, because that is what its parallel batch took end to end.
  test("attributes a parallel batch's wall time to the batch rather than to the call", () => {
    const html = renderDetails({ type: "tool_execution_end", toolName: "bash", isError: false, batchDurationMs: 6075, batchToolCalls: 2 });

    expect(html).toContain("批次耗时");
    expect(html).toContain("6.1 s");
    expect(html).toContain("—");
  });

  // The field said "经过的插件" over a value that is always one of three fixed data-source strings and has never named a plugin.
  test("names the data source for a runtime event as a data source", () => {
    const html = renderDetails({ type: "tool_execution_start", toolName: "bash", historical: true });

    expect(html).toContain("数据来源");
    expect(html).not.toContain("经过的插件");
    expect(html).toContain("Session JSONL · message history");
  });
});

describe("clipboard writes", () => {
  const withClipboard = (clipboard: unknown) => Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

  test("reports a refused write instead of leaving the rejection unhandled", async () => {
    withClipboard({ writeText: () => Promise.reject(new Error("Write permission denied.")) });

    await expect(copyTextToClipboard("{}")).resolves.toBe(false);
  });

  // A plain-http LAN console — the deployment the README documents — has no navigator.clipboard at all.
  test("reports a missing Clipboard API rather than silently doing nothing", async () => {
    withClipboard(undefined);

    await expect(copyTextToClipboard("{}")).resolves.toBe(false);
  });

  test("reports a write that landed", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    withClipboard({ writeText });

    await expect(copyTextToClipboard('{"a":1}')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('{"a":1}');
  });
});

describe("copy json button", () => {
  const renderPanel = async (onCopy: () => Promise<boolean>) => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Details, { event: { type: "tool_execution_end", toolName: "bash" }, onClose: () => {}, onCopy }));
      await Promise.resolve();
    });
    const copy = [...document.querySelectorAll("button")].find((button) => button.textContent === "复制 JSON");
    expect(copy).toBeDefined();
    return copy as HTMLButtonElement;
  };

  test("says the payload was copied", async () => {
    const copy = await renderPanel(() => Promise.resolve(true));

    await act(async () => {
      copy.click();
      await Promise.resolve();
    });

    expect(copy.textContent).toBe("已复制");
    expect(document.querySelector(".detail-copy-note")).toBeNull();
  });

  // Before, a browser that refuses the write left the button reading "复制 JSON" and the panel unchanged, so nothing on screen distinguished a copy that worked from one that never happened.
  test("offers the raw payload by hand when the clipboard is closed to the page", async () => {
    const copy = await renderPanel(() => Promise.resolve(false));

    await act(async () => {
      copy.click();
      await Promise.resolve();
    });

    expect(copy.textContent).toBe("复制失败");
    expect(document.querySelector(".detail-copy-note")?.textContent).toContain("已选中");
    const disclosure = document.querySelector<HTMLDetailsElement>(".raw-json");
    expect(disclosure?.open).toBe(true);
    expect(window.getSelection()?.toString()).toContain("tool_execution_end");
  });
});
