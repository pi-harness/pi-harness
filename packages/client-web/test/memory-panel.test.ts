import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const memory = {
  id: "id-1",
  key: "k".repeat(128),
  value: "v".repeat(64 * 1024),
  tags: Array.from({ length: 16 }, (_, index) => `tenant-${index + 1}-${"x".repeat(53)}`),
  createdAt: "2026-09-12T03:00:00.000Z",
  updatedAt: "2026-09-12T03:00:00.000Z",
};

test("keeps maximum memory keys, values, and every tag accessible", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "memory-panel",
        pluginId: "@pi-harness/plugin-memory",
        title: "Memory",
        data: { filePath: "/workspace/memory.json", count: 1, shown: 1, truncated: false, last: null, memories: [memory] },
      },
    }),
  );

  expect(html).toContain(memory.key);
  expect(html).toContain(memory.value);
  for (const tag of memory.tags) expect(html).toContain(tag);
  expect(html).not.toMatch(/class="[^"]*truncate/u);
  expect(html).toMatch(/overflow-wrap:anywhere/u);
  expect(html).toContain('aria-label="跨会话记忆"');
  expect(html).toContain('aria-label="' + memory.key + '"');
  expect(html.match(/tabindex="0"/gu)).toHaveLength(2);
});

test("keeps all eight backend-bounded recent memories in a scrollable list", () => {
  const memories = Array.from({ length: 8 }, (_, index) => ({
    ...memory,
    id: `id-${index + 1}`,
    key: `tenant-${8 - index}`,
    value: `fact-${8 - index}`,
    tags: [],
  }));
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "memory-panel",
        pluginId: "@pi-harness/plugin-memory",
        title: "Memory",
        data: { filePath: "/workspace/memory.json", count: 12, shown: 8, truncated: true, last: null, memories },
      },
    }),
  );
  for (const item of memories) expect(html).toContain(item.value);
  expect(html).toContain("max-h-[40rem]");
  expect(html).toContain("最近 8 条有效记录");
});

test("renders every bounded result and completeness metadata from the latest search", () => {
  const matches = Array.from({ length: 8 }, (_, index) => ({
    ...memory,
    id: `search-${index + 1}`,
    key: `billing-${8 - index}`,
    value: `matched-fact-${8 - index}`,
    tags: [],
    updatedAt: `2026-09-12T03:00:0${8 - index}.000Z`,
  }));
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "memory-panel",
        pluginId: "@pi-harness/plugin-memory",
        title: "Memory",
        data: {
          filePath: "/workspace/memory.json",
          count: 1,
          shown: 1,
          truncated: false,
          last: { query: "billing", total: 12, shown: 8, truncated: true, memories: matches },
          memories: [memory],
        },
      },
    }),
  );

  expect(html).toContain("最近搜索：billing");
  expect(html).toContain("8 / 12 条");
  for (const item of matches) expect(html).toContain(item.value);
  expect(html).toContain('aria-label="最近搜索：billing"');
  expect(html.match(/tabindex="0"/gu)).toHaveLength(11);
  expect(html).toContain("完整计数保留在上方");
});

test("rejects contradictory memory panel inventories", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "memory-panel",
        pluginId: "@pi-harness/plugin-memory",
        title: "Memory",
        data: { filePath: "/workspace/memory.json", count: 99, shown: 1, truncated: false, last: null, memories: [memory] },
      },
    }),
  );
  expect(html).toContain("Memory 面板数据异常");
  expect(html).not.toContain(memory.key);
  expect(html).not.toContain("99");
});
