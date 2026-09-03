import { describe, expect, it } from "vitest";
import { pluginStarsRows } from "../src/plugin-stars-view.js";

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
});
