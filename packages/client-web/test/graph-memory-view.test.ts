import { describe, expect, test } from "vitest";
import { graphMemoryPanelView } from "../src/graph-memory-view.js";

const timestamp = "2026-09-12T03:00:00.000Z";
const node = (id: string, kind: "task" | "skill" | "event" = "task") => ({
  id,
  kind,
  label: id,
  summary: `${id} summary`,
  source: `tenant://${id}`,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const relation = (id: string, from = "node-1", to = "node-2") => ({
  id,
  from,
  to,
  relation: "USED_SKILL",
  createdAt: timestamp,
});

function report() {
  return {
    filePath: "/agent/graph-memory.json",
    nodes: 2,
    relations: 1,
    kinds: { task: 1, skill: 1, event: 0 },
    recent: [node("node-1"), node("node-2", "skill")],
    recentRelations: [{ ...relation("rel-1"), fromLabel: "node-1", toLabel: "node-2" }],
    lastSearch: {
      query: "tenant",
      total: 2,
      nodes: [node("node-1"), node("node-2", "skill")],
      relations: [relation("rel-1")],
      offset: 0,
      nextOffset: null,
      nodesTruncated: false,
      relationsOffset: 0,
      relationsTotal: 1,
      nextRelationsOffset: null,
      relationsTruncated: false,
    },
    limits: {
      nodes: 2_000,
      relations: 5_000,
      fileBytes: 4_194_304,
      searchResults: 50,
    },
  };
}

describe("Graph memory panel view", () => {
  test("preserves the complete bounded graph inventory and latest search", () => {
    const view = graphMemoryPanelView(report());

    expect(view).toMatchObject({
      nodes: 2,
      relations: 1,
      kinds: { task: 1, skill: 1, event: 0 },
      recent: [{ id: "node-1", summary: "node-1 summary" }, { id: "node-2" }],
      recentRelations: [
        {
          id: "rel-1",
          relation: "USED_SKILL",
          fromLabel: "node-1",
          toLabel: "node-2",
        },
      ],
      lastSearch: {
        query: "tenant",
        total: 2,
        nodes: [{ id: "node-1" }, { id: "node-2" }],
        relations: [{ id: "rel-1" }],
      },
      malformed: false,
      truncated: false,
    });
  });

  test("accepts all eight recent records and maximum-size fields without clipping", () => {
    const summary = "界".repeat(5_000);
    const nodes = Array.from({ length: 8 }, (_, index) => ({
      ...node(`tenant-${index}`),
      label: `tenant-${index}-${"l".repeat(147)}`,
      summary,
    }));
    const relations = Array.from({ length: 8 }, (_, index) => ({
      ...relation(`relation-${index}`, `tenant-${index}`, `tenant-${(index + 1) % 8}`),
      fromLabel: nodes[index]!.label,
      toLabel: nodes[(index + 1) % 8]!.label,
    }));
    const value = {
      ...report(),
      nodes: 8,
      relations: 8,
      kinds: { task: 8, skill: 0, event: 0 },
      recent: nodes,
      recentRelations: relations,
      lastSearch: null,
    };

    const view = graphMemoryPanelView(value);

    expect(view.malformed).toBe(false);
    expect(view.recent).toHaveLength(8);
    expect(view.recentRelations).toHaveLength(8);
    expect(view.recent[0]?.summary).toBe(summary);
    expect(view.recent[0]?.label).toBe(nodes[0]?.label);
  });

  test("fails closed on contradictory inventories, non-canonical data, accessors, and proxies", () => {
    const accessor = report();
    let accessed = false;
    Object.defineProperty(accessor, "nodes", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("accessor executed");
      },
    });
    const revoked = Proxy.revocable(report(), {});
    revoked.revoke();
    const malformed = [
      null,
      { ...report(), nodes: 3 },
      { ...report(), kinds: { task: 2, skill: 0, event: 0 } },
      {
        ...report(),
        recent: [{ ...node("node-1"), updatedAt: "2026-09-12T03:00:00Z" }, node("node-2", "skill")],
      },
      {
        ...report(),
        recent: [{ ...node("node-1"), summary: "refund\0workflow" }, node("node-2", "skill")],
      },
      {
        ...report(),
        lastSearch: {
          ...report().lastSearch,
          nodesTruncated: true,
          nextOffset: null,
        },
      },
      { ...report(), limits: { ...report().limits, nodes: 1 } },
      { ...report(), limits: { ...report().limits, fileBytes: 1 } },
      { ...report(), limits: { ...report().limits, searchResults: 1 } },
      { ...report(), lastSearch: { ...report().lastSearch, total: 3 } },
      { ...report(), lastSearch: { ...report().lastSearch, relationsTotal: 2 } },
      {
        ...report(),
        lastSearch: { ...report().lastSearch, relations: [{ ...relation("unrelated", "alien-a", "alien-b") }] },
      },
      {
        ...report(),
        lastSearch: { ...report().lastSearch, nodes: [node("node-3"), node("node-4")], relations: [] as unknown[], relationsTotal: 0 },
      },
      {
        ...report(),
        lastSearch: { ...report().lastSearch, nodes: [{ ...node("node-1"), summary: "conflicting snapshot" }, node("node-2", "skill")] },
      },
      {
        ...report(),
        lastSearch: { ...report().lastSearch, relations: [{ ...relation("rel-1", "node-1", "external-node") }] },
      },
      {
        ...report(),
        recentRelations: [{ ...report().recentRelations[0], fromLabel: "tenant-b/order-100" }],
      },
      {
        ...report(),
        relations: 2,
        recentRelations: [...report().recentRelations, { ...report().recentRelations[0], id: "rel-duplicate" }],
      },
      accessor,
      revoked.proxy,
    ];

    for (const value of malformed)
      expect(graphMemoryPanelView(value)).toMatchObject({
        malformed: true,
        nodes: 0,
        recent: [],
        lastSearch: null,
      });
    expect(accessed).toBe(false);
  });

  test("orders canonical expanded-year timestamps by time instead of text", () => {
    const newer = { ...node("node-1"), createdAt: "+010000-01-01T00:00:00.000Z", updatedAt: "+010000-01-01T00:00:00.000Z" };
    const older = { ...node("node-2", "skill"), createdAt: "9999-01-01T00:00:00.000Z", updatedAt: "9999-01-01T00:00:00.000Z" };
    const value = { ...report(), recent: [newer, older], lastSearch: null };

    expect(graphMemoryPanelView(value)).toMatchObject({ malformed: false, recent: [{ id: "node-1" }, { id: "node-2" }] });
  });
});
