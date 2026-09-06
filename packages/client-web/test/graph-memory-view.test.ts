import { describe, expect, test } from "vitest";
import { graphMemoryPanelView } from "../src/graph-memory-view.js";

describe("Graph memory panel view", () => {
  test("normalizes graph counts, recent nodes, relations, search, and limits", () => {
    const view = graphMemoryPanelView({
      nodes: 2,
      relations: 1,
      kinds: { task: 1, skill: 1, event: 0 },
      recent: [
        {
          id: "node-1",
          kind: "task",
          label: "Ship",
          summary: "Run verification",
          source: "release",
          createdAt: "2026-09-05T00:00:00.000Z",
          updatedAt: "2026-09-05T01:00:00.000Z",
        },
      ],
      recentRelations: [
        { id: "rel-1", from: "node-1", to: "node-2", relation: "USED_SKILL", createdAt: "2026-09-05T01:00:00.000Z", fromLabel: "Ship", toLabel: "Verify" },
      ],
      lastSearch: { query: "verify", total: 2, nodes: [{ id: "node-1" }], relations: [] },
      limits: { nodes: 2_000, relations: 5_000, fileBytes: 4_194_304, searchResults: 50 },
    });

    expect(view).toMatchObject({
      nodes: 2,
      relations: 1,
      kinds: { task: 1, skill: 1, event: 0 },
      recent: [{ id: "node-1", kind: "task", label: "Ship", summary: "Run verification", source: "release", updatedAt: "2026-09-05T01:00:00.000Z" }],
      recentRelations: [{ relation: "USED_SKILL", fromLabel: "Ship", toLabel: "Verify" }],
      lastSearch: { query: "verify", total: 2, shown: 1 },
      limits: { nodes: 2_000, relations: 5_000, fileBytes: 4_194_304, searchResults: 50 },
      truncated: false,
    });
  });

  test("bounds hostile graph arrays and strings while rejecting malformed entries", () => {
    const recent = Array.from({ length: 12 }, (_, index) => ({
      id: `node-${index}`,
      kind: index === 0 ? "invalid" : "event",
      label: "l".repeat(300),
      summary: "s".repeat(5_000),
      source: "p".repeat(1_000),
      createdAt: "invalid",
      updatedAt: "invalid",
    }));
    const view = graphMemoryPanelView({
      nodes: -1,
      relations: Number.NaN,
      kinds: { task: -1 },
      recent,
      recentRelations: [{}],
      lastSearch: { query: "q".repeat(300), total: -1, nodes: new Array(100) },
      limits: {},
    });

    expect(view.nodes).toBe(7);
    expect(view.recent).toHaveLength(7);
    expect(view.recent[0]).toMatchObject({ label: "l".repeat(160), summary: "s".repeat(2_000), source: "p".repeat(512), updatedAt: null });
    expect(view.recentRelations).toEqual([]);
    expect(view.lastSearch).toEqual({ query: "q".repeat(160), total: 50, shown: 50 });
    expect(view.truncated).toBe(true);
  });
});
