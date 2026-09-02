import { describe, expect, test } from "vitest";
import { MARKETPLACE_CAPABILITIES, MARKETPLACE_CATEGORIES, MARKETPLACE_PLUGINS, paginateMarketplace, searchMarketplace } from "../src/marketplace.js";

describe("plugin marketplace registry", () => {
  test("contains reviewable, uniquely identified entries", () => {
    expect(MARKETPLACE_PLUGINS.length).toBeGreaterThan(0);
    expect(new Set(MARKETPLACE_PLUGINS.map((plugin) => plugin.id)).size).toBe(MARKETPLACE_PLUGINS.length);
    expect(
      MARKETPLACE_PLUGINS.every((plugin) => plugin.repository.startsWith("https://") && plugin.license && plugin.profile.name === plugin.packageName),
    ).toBe(true);
  });

  test("filters by query and capability without mutating the registry", () => {
    const result = searchMarketplace("timer", "scheduling");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(searchMarketplace("does-not-exist")).toEqual([]);
    expect(MARKETPLACE_PLUGINS.length).toBe(3);
  });

  test("filters by a declared category independently from capabilities", () => {
    const result = searchMarketplace("", "", "runtime");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(result[0]?.category).toEqual({ id: "runtime", label: "运行时" });
    expect(MARKETPLACE_CATEGORIES).toEqual(expect.arrayContaining([{ id: "runtime", label: "运行时", count: 1 }]));
  });

  test("loads one entry per file and paginates the filtered result", () => {
    const page = paginateMarketplace(searchMarketplace(), 1, 2);
    expect(page).toEqual({ items: MARKETPLACE_PLUGINS.slice(2, 3), total: 3, page: 1, pageSize: 2, hasNext: false });
    expect(MARKETPLACE_CAPABILITIES).toContain("scheduling");
  });
});
