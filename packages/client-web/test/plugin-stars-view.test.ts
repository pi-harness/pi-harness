import { describe, expect, it } from "vitest";
import { pluginStarsPanelView, pluginStarsRows } from "../src/plugin-stars-view.js";

describe("plugin stars view", () => {
  it("sorts by stars and limits the visible ranking rows", () => {
    expect(
      pluginStarsRows(
        [
          { fullName: "team/low", name: "low", stars: 4, htmlUrl: "https://github.com/team/low", updatedAt: "2026-01-01" },
          { fullName: "team/high", name: "high", stars: 20, htmlUrl: "https://github.com/team/high", updatedAt: "2026-02-01" },
          { fullName: "team/mid", name: "mid", stars: 9, htmlUrl: "https://github.com/team/mid", updatedAt: "2026-03-01" },
        ],
        2,
      ),
    ).toEqual([
      { rank: 1, fullName: "team/high", name: "high", stars: 20, htmlUrl: "https://github.com/team/high", updatedAt: "2026-02-01" },
      { rank: 2, fullName: "team/mid", name: "mid", stars: 9, htmlUrl: "https://github.com/team/mid", updatedAt: "2026-03-01" },
    ]);
  });

  it("normalizes a complete plugin stars panel payload", () => {
    expect(
      pluginStarsPanelView({
        source: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json",
        limit: 10,
        timeoutMs: 15_000,
        latest: {
          source: "fixture",
          generatedAt: "2026-09-05T00:00:00Z",
          total: 2,
          query: "vision",
          fetchedAt: "2026-09-05T00:01:00Z",
          results: [{ fullName: "owner/fixture", name: "fixture", stars: 2, htmlUrl: "https://github.com/owner/fixture", updatedAt: "2026-09-05" }],
        },
        inventory: { total: 2, shown: 1, truncated: true },
        limits: { responseBytes: 2_097_152, sourceItems: 1_000, resultItems: 10, panelItems: 20, queryCharacters: 120, timeoutMs: 15_000 },
      }),
    ).toEqual({
      source: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json",
      limit: 10,
      timeoutMs: 15_000,
      latest: {
        source: "fixture",
        generatedAt: "2026-09-05T00:00:00Z",
        total: 2,
        query: "vision",
        fetchedAt: "2026-09-05T00:01:00Z",
        results: [
          {
            rank: 1,
            fullName: "owner/fixture",
            name: "fixture",
            stars: 2,
            htmlUrl: "https://github.com/owner/fixture",
            updatedAt: "2026-09-05",
          },
        ],
      },
      inventory: { total: 2, shown: 1, truncated: true },
      limits: { responseBytes: 2_097_152, sourceItems: 1_000, resultItems: 10, panelItems: 20, queryCharacters: 120, timeoutMs: 15_000 },
      malformed: false,
    });
  });

  it("keeps a leaderboard carrying more results than the visible ranking rows", () => {
    const view = pluginStarsPanelView({
      source: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json",
      limit: 10,
      timeoutMs: 15_000,
      latest: {
        source: "fixture",
        generatedAt: "2026-09-05T00:00:00Z",
        total: 10,
        query: "",
        fetchedAt: "2026-09-05T00:01:00Z",
        results: Array.from({ length: 10 }, (_, index) => ({
          fullName: `owner/plugin-${index}`,
          name: `plugin-${index}`,
          stars: 100 - index,
          htmlUrl: `https://github.com/owner/plugin-${index}`,
          updatedAt: "2026-09-05",
        })),
      },
      inventory: { total: 10, shown: 10, truncated: false },
      limits: { responseBytes: 2_097_152, sourceItems: 1_000, resultItems: 10, panelItems: 20, queryCharacters: 120, timeoutMs: 15_000 },
    });

    expect(view.malformed).toBe(false);
    expect(view.latest?.results).toHaveLength(8);
    expect(view.latest?.results[0]).toMatchObject({ rank: 1, fullName: "owner/plugin-0", stars: 100 });
    expect(view.latest?.results[7]).toMatchObject({ rank: 8, fullName: "owner/plugin-7", stars: 93 });
    expect(view.inventory).toEqual({ total: 10, shown: 8, truncated: true });
  });

  it("fails closed for hostile panel values, repository rows, and inventory counts", () => {
    const long = "x".repeat(10_000);
    const view = pluginStarsPanelView({
      source: long,
      limit: Number.POSITIVE_INFINITY,
      timeoutMs: -1,
      latest: {
        source: long,
        generatedAt: long,
        total: 99_999,
        query: long,
        fetchedAt: long,
        results: [
          { fullName: "invalid", name: long, stars: -1, htmlUrl: "javascript:alert(1)", updatedAt: long },
          ...Array.from({ length: 20 }, (_, index) => ({
            fullName: `owner/repository-${index}`,
            name: long,
            stars: 20 - index,
            htmlUrl: `https://github.com/owner/repository-${index}`,
            updatedAt: long,
          })),
        ],
      },
      inventory: { total: 99_999, shown: 99_999, truncated: false },
      limits: {},
    });

    expect(view).toMatchObject({ malformed: true, latest: null, inventory: { total: 0, shown: 0 }, source: "" });
  });

  it("fails closed for accessor-backed payloads", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "latest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return null;
      },
    });
    expect(pluginStarsPanelView(accessor).malformed).toBe(true);
    expect(getterCalls).toBe(0);
  });
});
