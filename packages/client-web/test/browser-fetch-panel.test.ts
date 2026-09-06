import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "browser-fetch-panel", pluginId: "@pi-harness/core/plugins/browser-fetch", title: "Browser Fetch", data },
    }),
  );
}

const limits = { maxResponseBytes: 512 * 1024, maxPanelTextChars: 12_000, maxRedirects: 3, timeoutMs: 20_000 };

describe("Browser Fetch panel", () => {
  test("renders a validated response and limits", () => {
    const html = renderPanel({
      latest: {
        url: "https://example.com/start",
        finalUrl: "https://example.com/final",
        status: 200,
        contentType: "text/plain",
        bytes: 4,
        truncated: false,
        previewTruncated: false,
        text: "done",
      },
      allowPrivate: false,
      ...limits,
    });
    expect(html).toContain("HTTP 200");
    expect(html).toContain("done");
    expect(html).toContain("private:blocked");
    expect(html).not.toContain("面板数据异常");
  });

  test("fails closed for malformed response data", () => {
    const html = renderPanel({ latest: null, allowPrivate: false, ...limits, maxRedirects: 99 });
    expect(html).toContain("Browser Fetch 面板数据异常");
    expect(html).toContain("面板数据不完整或不可信");
    expect(html).not.toContain("还没有抓取网页");
  });

  test("renders a multi-line page preview instead of failing closed", () => {
    const html = renderPanel({
      latest: {
        url: "https://example.com/",
        finalUrl: "https://example.com/",
        status: 200,
        contentType: "text/html; charset=utf-8",
        bytes: 1_256,
        truncated: false,
        previewTruncated: false,
        text: "Example Domain\n\nThis domain is for use in illustrative examples.\n\tMore information...\r\n",
      },
      allowPrivate: false,
      ...limits,
    });
    expect(html).toContain("Example Domain");
    expect(html).toContain("More information...");
    expect(html).not.toContain("面板数据异常");
  });
});
