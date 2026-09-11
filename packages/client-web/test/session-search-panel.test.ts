import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const render = (data: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "session-search-panel", pluginId: "@pi-harness/plugin-session-search", title: "Session Search", data },
    }),
  );

test("distinguishes an empty search page from an exhausted search and exposes continuation arguments", () => {
  const html = render({ query: "needle", total: 0, items: [], scanned: 200, skipped: 0, truncated: true, nextCursor: "test-cursor" });
  expect(html).toContain("本页匹配 0 个会话");
  expect(html).toContain("还有未扫描的会话");
  expect(html).toContain("即使本页没有匹配");
  expect(html).toContain("test-cursor");
  expect(html).toContain("&quot;cursor&quot;");
  expect(html).not.toContain("目录扫描已结束");
});

test("reports exhaustion without claiming skipped files or clipped previews were checked", () => {
  const html = render({ query: "needle", total: 0, items: [], scanned: 5, skipped: 2, truncated: false, nextCursor: null });
  expect(html).toContain("本页匹配 0 个会话");
  expect(html).toContain("目录扫描已结束；跳过的文件和省略的预览不代表已完整检查。");
  expect(html).not.toContain("还有未扫描的会话");
});

test("does not claim exhaustion for an older plugin without continuation metadata", () => {
  const html = render({ query: "needle", total: 0, items: [], truncated: true });
  expect(html).not.toContain("目录扫描已结束");
  expect(html).not.toContain("本页匹配");
});
