import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const nodes = Array.from({ length: 500 }, (_, index) =>
  index === 0
    ? { kind: "directory", name: "tenants", path: "tenants", depth: 1 }
    : {
        kind: index % 2 === 0 ? "directory" : "file",
        name: `node-${String(index).padStart(3, "0")}`,
        path: `tenants/node-${String(index).padStart(3, "0")}`,
        depth: 2,
      },
);
const entries = Array.from({ length: 500 }, (_, index) => ({
  status: " M",
  path: `tenants/tenant-${String(index).padStart(3, "0")}/orders/refunds/long-segment/change-${String(index).padStart(3, "0")}.ts`,
}));
const data = {
  cwd: "/workspace/commerce-platform",
  latest: { nodes, directoryCount: 250, fileCount: 250, truncated: false, scannedEntries: 500, path: ".", maxDepth: 4, maxNodes: 500 },
  git: { available: true, failureReason: null, branch: "audit/tenant-refunds", clean: false, entries, changedCount: 500, truncated: false },
  nodeCount: 500,
  gitTimeoutMs: 10_000,
};

function render(value: unknown = data): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "workspace-navigator-panel", pluginId: "@pi-harness/plugin-workspace-navigator", title: "Workspace Navigator", data: value },
    }),
  );
}

test("renders every bounded tree node and Git change with full keyboard-accessible paths", () => {
  const html = render();

  for (const node of nodes) expect(html).toContain(node.path);
  for (const entry of entries) expect(html).toContain(entry.path);
  expect(html).toContain("已扫描 500 个目录条目");
  expect(html).toContain('aria-label="工作区目录树节点"');
  expect(html).toContain('role="tree"');
  expect(html.match(/role="treeitem"/gu)).toHaveLength(500);
  expect(html).toContain('aria-level="1"');
  expect(html).toContain('aria-label="目录：tenants"');
  expect(html).toContain('aria-label="文件：tenants/node-001"');
  expect(html).toContain('aria-label="工作区 Git 变更"');
  expect(html.match(/tabindex="0"/gu)).toHaveLength(2);
  expect(html.match(/focus-visible:outline-2/gu)).toHaveLength(2);
  expect(html).not.toContain("truncate");
});

test("shows an actionable reason when Git status is unavailable", () => {
  const html = render({
    ...data,
    git: { available: false, failureReason: "timeout", branch: null, clean: false, entries: [], changedCount: 0, truncated: false },
  });

  expect(html).toContain("Git 状态读取超时；请提高 gitTimeoutMs 或缩小工作区。");
});

test("shows an explicit error instead of rendering malformed navigator data", () => {
  const html = render({ ...data, nodeCount: 499 });

  expect(html).toContain("Workspace Navigator 面板数据异常");
  expect(html).not.toContain(nodes[0]!.path);
  expect(html).not.toContain(entries[0]!.path);
});
