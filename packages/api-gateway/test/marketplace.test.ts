import { describe, expect, test } from "vitest";
import {
  MARKETPLACE_CAPABILITIES,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_PLUGINS,
  attachMarketplaceStatistics,
  createMarketplaceStatisticsLoader,
  marketplaceNpmPackageName,
  needsMarketplacePackageInstall,
  paginateMarketplace,
  searchMarketplace,
  sortMarketplaceByRecommendation,
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
    expect(official.get("session-bridge")?.capabilities).toContain("five-part preview");
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
    expect(official.get("session-compare")?.category.id).toBe("discovery");
    expect(official.get("secure-audit")?.category.id).toBe("security");
    expect(official.get("session-bookmarks")?.category.id).toBe("workflow");
    expect(official.get("llm-verifier")?.category.id).toBe("testing");
    expect(official.get("module-search")?.category.id).toBe("discovery");
    expect(official.get("workspace-navigator")?.category.id).toBe("developer");
    expect(official.get("reverse-skill")?.category.id).toBe("security");
    expect(official.get("colleague-skill")?.category.id).toBe("workflow");
    expect(official.get("prompt-library")?.category.id).toBe("workflow");
    expect(official.get("cleaner")?.category.id).toBe("developer");
    expect(official.get("cli-notifier")?.category.id).toBe("workflow");
    expect(official.get("obsidian-sync")?.category.id).toBe("workflow");
    expect(official.get("tab-manager")?.category.id).toBe("workflow");
    expect(official.get("telemetry-blocker")?.category.id).toBe("security");
    expect(official.get("runtime-doctor")?.category.id).toBe("developer");
    expect(official.get("better-sidebar")?.category.id).toBe("developer");
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

  test("maps plugin entry points to their published npm package", () => {
    expect(marketplaceNpmPackageName("@pi-harness/core/plugins/agent-teams")).toBe("@pi-harness/core");
    expect(marketplaceNpmPackageName("@deepseek-ai/cordis-plugin-timer")).toBe("@deepseek-ai/cordis-plugin-timer");
    expect(marketplaceNpmPackageName("unscoped-package/runtime")).toBe("unscoped-package");
  });

  test("loads and caches npm marketplace statistics without treating unpublished packages as zero-download packages", async () => {
    const requests: string[] = [];
    const fetcher = (url: string): Promise<Response> => {
      requests.push(url);
      if (url.startsWith("https://registry.npmjs.org/-/v1/search")) {
        const name = new URL(url).searchParams.get("text");
        const objects =
          name === "@deepseek-ai/cordis-plugin-timer"
            ? [
                {
                  package: {
                    name,
                    scope: "deepseek-ai",
                    version: "1.1.4",
                    description: "Cordis timer service",
                    keywords: ["cordis", "timer"],
                    date: "2026-08-30T13:14:00.557Z",
                    links: { npm: "https://www.npmjs.com/package/@deepseek-ai/cordis-plugin-timer" },
                    publisher: { username: "deepseek-ai", email: "opensource@deepseek.com" },
                    maintainers: [{ username: "deepseek-ai", email: "opensource@deepseek.com" }],
                  },
                  score: { final: 0.95, detail: { quality: 0.92, popularity: 0.98, maintenance: 0.96 } },
                  searchScore: 100000.95,
                },
              ]
            : [];
        return Promise.resolve(Response.json({ objects, total: objects.length, time: "2026-09-03T00:00:00.000Z" }));
      }
      if (url === "https://api.npmjs.org/downloads/point/last-month/%40deepseek-ai%2Fcordis-plugin-timer") {
        return Promise.resolve(Response.json({ downloads: 1_014_632, start: "2026-07-31", end: "2026-08-29", package: "@deepseek-ai/cordis-plugin-timer" }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
    const load = createMarketplaceStatisticsLoader({ fetcher, now: () => 1_000, ttlMs: 60_000 });
    const plugins = MARKETPLACE_PLUGINS.filter((plugin) => plugin.id === "agent-teams" || plugin.id === "cordis-timer");

    const first = await load(plugins);
    const second = await load(plugins);

    expect(first.get("@deepseek-ai/cordis-plugin-timer")).toEqual({ downloads30d: 1_014_632, quality: 0.92, updatedAt: "2026-08-30T13:14:00.557Z" });
    expect(first.has("@pi-harness/core")).toBe(false);
    expect(second).toBe(first);
    expect(requests).toHaveLength(3);
  });

  test("keeps partial npm statistics when the download endpoint is unavailable", async () => {
    const fetcher = (url: string): Promise<Response> => {
      if (url.startsWith("https://registry.npmjs.org/-/v1/search")) {
        const name = new URL(url).searchParams.get("text");
        return Promise.resolve(
          Response.json({
            objects: [
              {
                package: { name, version: "1.1.4", date: "2026-08-30T13:14:00.557Z" },
                score: { final: 0.9, detail: { quality: 0.8, popularity: 0.9, maintenance: 1 } },
                searchScore: 100000.9,
              },
            ],
            total: 1,
            time: "2026-09-03T00:00:00.000Z",
          }),
        );
      }
      throw new Error("npm downloads unavailable");
    };
    const load = createMarketplaceStatisticsLoader({ fetcher });
    const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === "cordis-timer")!;

    await expect(load([plugin])).resolves.toEqual(new Map([["@deepseek-ai/cordis-plugin-timer", { quality: 0.8, updatedAt: "2026-08-30T13:14:00.557Z" }]]));
  });

  test("retries npm statistics after a short failure cache expires", async () => {
    let available = false;
    let timestamp = 1_000;
    let requests = 0;
    const fetcher = (url: string): Promise<Response> => {
      requests += 1;
      if (!available) throw new Error("npm unavailable");
      if (url.startsWith("https://registry.npmjs.org/-/v1/search")) {
        return Promise.resolve(
          Response.json({
            objects: [
              {
                package: { name: "@deepseek-ai/cordis-plugin-timer", version: "1.1.4", date: "2026-08-30T13:14:00.557Z" },
                score: { final: 0.9, detail: { quality: 0.9, popularity: 0.9, maintenance: 0.9 } },
                searchScore: 100000.9,
              },
            ],
            total: 1,
            time: "2026-09-03T00:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({ downloads: 1_000, start: "2026-07-31", end: "2026-08-29", package: "@deepseek-ai/cordis-plugin-timer" }));
    };
    const load = createMarketplaceStatisticsLoader({ fetcher, now: () => timestamp, ttlMs: 60_000, failureTtlMs: 100 });
    const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === "cordis-timer")!;

    await expect(load([plugin])).resolves.toEqual(new Map());
    available = true;
    timestamp += 50;
    await expect(load([plugin])).resolves.toEqual(new Map());
    timestamp += 51;
    await expect(load([plugin])).resolves.toEqual(
      new Map([["@deepseek-ai/cordis-plugin-timer", { downloads30d: 1_000, quality: 0.9, updatedAt: "2026-08-30T13:14:00.557Z" }]]),
    );
    expect(requests).toBe(3);
  });

  test("sorts recommendations before pagination using verification, npm quality, downloads and recency", () => {
    const base = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "cordis-timer")!;
    const plugins = [
      { ...base, id: "older-popular", name: "Older popular", packageName: "older-popular", status: "verified" as const },
      { ...base, id: "recent-quality", name: "Recent quality", packageName: "recent-quality", status: "verified" as const },
      { ...base, id: "experimental", name: "Experimental", packageName: "experimental", status: "experimental" as const },
    ];
    const statistics = new Map([
      ["older-popular", { downloads30d: 1_000_000, quality: 0.8, updatedAt: "2025-09-03T00:00:00.000Z" }],
      ["recent-quality", { downloads30d: 100_000, quality: 0.95, updatedAt: "2026-09-01T00:00:00.000Z" }],
      ["experimental", { downloads30d: 10_000_000, quality: 1, updatedAt: "2026-09-03T00:00:00.000Z" }],
    ]);

    const ranked = sortMarketplaceByRecommendation(attachMarketplaceStatistics(plugins, statistics), Date.parse("2026-09-03T00:00:00.000Z"));
    const page = paginateMarketplace(ranked, 0, 2);

    expect(ranked.map((plugin) => plugin.id)).toEqual(["recent-quality", "older-popular", "experimental"]);
    expect(page.items.map((plugin) => plugin.id)).toEqual(["recent-quality", "older-popular"]);
    expect(ranked[0]?.statistics).toEqual(statistics.get("recent-quality"));
  });
});
