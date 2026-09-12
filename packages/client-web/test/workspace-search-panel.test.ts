import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const matches = Array.from({ length: 100 }, (_, index) => ({
  path: `apps/tenant-${index}/${"nested/".repeat(40)}refund-handler.ts`,
  line: index + 1,
  text: `match-${String(index).padStart(3, "0")} ${"evidence ".repeat(54)}`,
}));
const data = {
  cwd: "/workspace/commerce-platform",
  query: "tenant refund",
  matchCount: 100,
  scannedFiles: 1_997,
  latest: {
    query: "tenant refund",
    path: ".",
    matches,
    matchCount: 100,
    scannedFiles: 1_997,
    skippedFiles: 3,
    truncated: true,
    scannedEntries: 4_096,
    readBytes: 67_108_864,
  },
};

test("renders every backend-bounded workspace match and full scan metadata accessibly", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "workspace-search-panel", pluginId: "@pi-harness/plugin-workspace-search", title: "Workspace Search", data },
    }),
  );

  for (const item of matches) {
    expect(html).toContain(item.path);
    expect(html).toContain(item.text);
  }
  expect(html).toContain("已扫描 4096 个目录条目");
  expect(html).toContain("读取 67108864 bytes");
  expect(html).toContain("max-h-[40rem]");
  expect(html).toContain('tabindex="0"');
  expect(html).toContain("focus-visible:outline-2");
  expect(html).toContain("focus-visible:outline-[var(--color-blue)]");
  expect(html).not.toContain("truncate");
});

test("shows an explicit error for malformed workspace-search panel data", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "workspace-search-panel", pluginId: "@pi-harness/plugin-workspace-search", title: "Workspace Search", data: { ...data, matchCount: 99 } },
    }),
  );

  expect(html).toContain("Workspace Search 面板数据异常");
  expect(html).toContain('class="mt-3 rounded-lg border border-[#f4caca]');
  expect(html).not.toContain(matches[0]!.text);
});
