import { describe, expect, test } from "vitest";
import { MARKETPLACE_PLUGINS, searchMarketplace } from "../src/marketplace.js";

describe("plugin marketplace registry", () => {
  test("contains reviewable, uniquely identified entries", () => {
    expect(MARKETPLACE_PLUGINS.length).toBeGreaterThan(0);
    expect(new Set(MARKETPLACE_PLUGINS.map((plugin) => plugin.id)).size).toBe(MARKETPLACE_PLUGINS.length);
    expect(MARKETPLACE_PLUGINS.every((plugin) => plugin.repository.startsWith("https://") && plugin.license && plugin.profile.name === plugin.packageName)).toBe(true);
  });

  test("filters by query and capability without mutating the registry", () => {
    const result = searchMarketplace("timer", "scheduling");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(searchMarketplace("does-not-exist")).toEqual([]);
    expect(MARKETPLACE_PLUGINS.length).toBe(4);
  });
});
