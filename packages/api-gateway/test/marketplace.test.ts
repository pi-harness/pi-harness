import { describe, expect, test } from "vitest";
import {
  MARKETPLACE_CAPABILITIES,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_PLUGINS,
  needsMarketplacePackageInstall,
  paginateMarketplace,
  searchMarketplace,
} from "../src/marketplace.js";

describe("plugin marketplace registry", () => {
  test("contains reviewable, uniquely identified entries", () => {
    expect(MARKETPLACE_PLUGINS.length).toBeGreaterThan(0);
    expect(new Set(MARKETPLACE_PLUGINS.map((plugin) => plugin.id)).size).toBe(MARKETPLACE_PLUGINS.length);
    expect(
      MARKETPLACE_PLUGINS.every((plugin) => plugin.repository.startsWith("https://") && plugin.license && plugin.profile.name === plugin.packageName),
    ).toBe(true);
  });

  test("publishes the high-value official plugins in the same marketplace registry", () => {
    const official = new Map(MARKETPLACE_PLUGINS.filter((plugin) => plugin.source === "official").map((plugin) => [plugin.id, plugin]));
    expect(official.get("agent-teams")?.category.id).toBe("collaboration");
    expect(official.get("plugin-stars")?.category.id).toBe("discovery");
    expect(official.get("vision-toolkit")?.category.id).toBe("multimodal");
    expect(official.get("session-bridge")?.category.id).toBe("workflow");
    expect(official.get("skill-guard")?.category.id).toBe("security");
    expect(official.get("cost-meter")?.category.id).toBe("observability");
    expect(official.get("skill-catalog")?.category.id).toBe("discovery");
    expect(official.get("prompt-guard")?.category.id).toBe("security");
    expect(official.get("browser-fetch")?.category.id).toBe("web");
    expect(official.get("web-research")?.category.id).toBe("web");
    expect(official.get("mcp-client")?.category.id).toBe("tools");
    expect(official.get("at-file")?.category.id).toBe("context");
    expect(official.get("dependency-checker")?.category.id).toBe("workflow");
    expect(official.get("token-guard")?.category.id).toBe("observability");
    expect(official.get("recall-unread")?.category.id).toBe("workflow");
    expect(official.get("turn-rewind")?.category.id).toBe("workflow");
    expect(official.get("context-doctor")?.category.id).toBe("observability");
    expect(official.get("history-compressor")?.category.id).toBe("context");
    expect(official.get("reviewer-bot")?.category.id).toBe("workflow");
    expect(official.get("auto-mode")?.category.id).toBe("security");
    expect(official.get("plan-execute")?.category.id).toBe("workflow");
    expect(official.get("canvas-draw")?.category.id).toBe("multimodal");
    expect(official.get("image-compressor")?.category.id).toBe("multimodal");
    expect(official.get("code2skill")?.category.id).toBe("tools");
    expect(official.get("workspace-search")?.category.id).toBe("context");
    expect(official.get("plugin-check")?.category.id).toBe("security");
    expect(official.get("test-harness")?.category.id).toBe("testing");
    expect(official.get("git-time-capsule")?.category.id).toBe("workflow");
    expect(official.get("yaml-validator")?.category.id).toBe("developer");
    expect(official.get("browser-session")?.category.id).toBe("web");
    expect(official.get("docker-sandbox")?.category.id).toBe("security");
    expect(official.get("mock-server")?.category.id).toBe("tools");
    expect(official.get("sql-lens")?.category.id).toBe("tools");
    expect(official.get("i18n-pair")?.category.id).toBe("workflow");
    expect(official.get("plugin-finder")?.category.id).toBe("discovery");
    expect(official.get("readme-gen")?.category.id).toBe("developer");
    expect(official.get("anchored-standard")?.category.id).toBe("security");
    expect(official.get("change-verifier")?.category.id).toBe("workflow");
    expect(official.get("openpets")?.category.id).toBe("web");
    expect(official.get("session-insights")?.category.id).toBe("observability");
    expect(official.get("mcp-panel")?.category.id).toBe("tools");
    expect(official.get("fail-logger")?.category.id).toBe("observability");
    expect(official.get("plugin-dev")?.category.id).toBe("developer");
    expect(official.get("session-export")?.category.id).toBe("workflow");
    expect(official.get("session-search")?.category.id).toBe("discovery");
    expect(official.get("session-bookmarks")?.category.id).toBe("workflow");
    expect(official.get("cleaner")?.category.id).toBe("developer");
    expect(official.get("cli-notifier")?.category.id).toBe("workflow");
    expect(official.get("obsidian-sync")?.category.id).toBe("workflow");
    expect(official.get("tab-manager")?.category.id).toBe("workflow");
    expect(official.get("telemetry-blocker")?.category.id).toBe("security");
  });

  test("recognizes bundled core plugin subpaths without requiring an npm install", () => {
    const bundled = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "skill-guard");
    const external = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "cordis-timer");
    expect(bundled).toBeDefined();
    expect(external).toBeDefined();
    expect(needsMarketplacePackageInstall(bundled!)).toBe(false);
    expect(needsMarketplacePackageInstall(external!)).toBe(true);
  });

  test("filters by query and capability without mutating the registry", () => {
    const result = searchMarketplace("timer", "scheduling");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(searchMarketplace("does-not-exist")).toEqual([]);
    expect(MARKETPLACE_PLUGINS.length).toBeGreaterThan(3);
  });

  test("filters by a declared category independently from capabilities", () => {
    const result = searchMarketplace("", "", "runtime");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(result[0]?.category).toEqual({ id: "runtime", label: "运行时" });
    expect(MARKETPLACE_CATEGORIES).toEqual(expect.arrayContaining([{ id: "runtime", label: "运行时", count: 1 }]));
  });

  test("loads one entry per file and paginates the filtered result", () => {
    const page = paginateMarketplace(searchMarketplace(), 1, 2);
    expect(page).toEqual({
      items: MARKETPLACE_PLUGINS.slice(2, 4),
      total: MARKETPLACE_PLUGINS.length,
      page: 1,
      pageSize: 2,
      hasNext: MARKETPLACE_PLUGINS.length > 4,
    });
    expect(MARKETPLACE_CAPABILITIES).toContain("scheduling");
  });
});
