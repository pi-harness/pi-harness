import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const timestamp = "2026-09-12T03:00:00.000Z";
const node = (index: number) => ({
  id: `tenant-${index}/order-${100 + index}`,
  kind: index % 3 === 0 ? "task" : index % 3 === 1 ? "skill" : "event",
  label: `Tenant ${index} refund ${"L".repeat(130)}`,
  summary: `Fulfillment summary ${index}\n${"S".repeat(4_000)}`,
  source: `commerce://${"source/".repeat(60)}${index}`,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const relation = (index: number) => ({
  id: `relation-${index}`,
  from: `tenant-${index}/order-${100 + index}`,
  to: `tenant-${(index + 1) % 8}/order-${100 + ((index + 1) % 8)}`,
  relation: "RELATED_TO",
  createdAt: timestamp,
});

function data() {
  const recent = Array.from({ length: 8 }, (_, index) => node(index));
  const searchNodes = [
    { ...node(20), label: "Search-only tenant refund", summary: "Search-only fulfillment evidence", source: "commerce://search-only" },
    { ...node(21), label: "Search-only carrier delay", summary: "Search-only carrier evidence", source: "commerce://search-carrier" },
  ];
  const searchRelation = {
    id: "search-relation-only",
    from: searchNodes[0]!.id,
    to: recent[0]!.id,
    relation: "RELATED_TO",
    createdAt: timestamp,
  };
  const recentRelations = Array.from({ length: 8 }, (_, index) => ({
    ...relation(index),
    fromLabel: recent[index]!.label,
    toLabel: recent[(index + 1) % 8]!.label,
  }));
  return {
    filePath: "/agent/graph-memory.json",
    nodes: 10,
    relations: 9,
    kinds: { task: 4, skill: 3, event: 3 },
    recent,
    recentRelations,
    lastSearch: {
      query: "refund",
      total: 10,
      nodes: searchNodes,
      relations: [searchRelation],
      offset: 2,
      nextOffset: 4,
      nodesTruncated: true,
      relationsOffset: 4,
      relationsTotal: 8,
      nextRelationsOffset: 5,
      relationsTruncated: true,
    },
    limits: {
      nodes: 2_000,
      relations: 5_000,
      fileBytes: 4_194_304,
      searchResults: 50,
    },
  };
}

test("renders every backend-bounded graph record and complete fields in accessible scroll areas", () => {
  const value = data();
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "graph-memory-panel",
        pluginId: "@pi-harness/plugin-graph-memory",
        title: "Graph Memory",
        data: value,
      },
    }),
  );

  for (const item of value.recent) {
    expect(html).toContain(item.id);
    expect(html).toContain(item.label);
    expect(html).toContain(item.summary.split("\n")[1]);
    expect(html).toContain(item.source);
  }
  for (const item of value.recentRelations) expect(html).toContain(item.id);
  for (const item of value.lastSearch.nodes) {
    expect(html).toContain(item.id);
    expect(html).toContain(item.label);
    expect(html).toContain(item.summary);
    expect(html).toContain(item.source);
  }
  expect(html).toContain(value.lastSearch.relations[0]!.id);
  expect(html).toContain("最近搜索：refund");
  expect(html).toContain("搜索节点 2 / 10");
  expect(html).toContain("搜索关系 1 / 8");
  expect(html).toContain("节点页：偏移 2 · 下一偏移 4 · 已截断 是");
  expect(html).toContain("关系页：偏移 4 · 下一偏移 5 · 已截断 是");
  expect(html).toContain("创建：2026-09-12T03:00:00.000Z");
  expect(html).toContain("更新：2026-09-12T03:00:00.000Z");
  expect(html).toContain('tabindex="0"');
  expect(html).toContain("max-h-[40rem]");
  expect(html).not.toContain("line-clamp-2");
  expect(html).not.toContain(" truncate ");
});

test("shows an explicit error instead of rendering malformed graph data", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "graph-memory-panel",
        pluginId: "@pi-harness/plugin-graph-memory",
        title: "Graph Memory",
        data: { ...data(), nodes: 9 },
      },
    }),
  );

  expect(html).toContain("Graph Memory 面板数据异常");
  expect(html).not.toContain("Tenant 0 refund");
});
