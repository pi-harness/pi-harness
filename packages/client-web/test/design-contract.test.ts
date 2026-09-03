import { describe, expect, it } from "vitest";
import { DESIGN_EVENTS, DESIGN_PLUGINS, DESIGN_SESSIONS, DESIGN_WORKSPACES, DESIGN_TURNS, DESIGN_PROVIDERS, DESIGN_TOML } from "../src/design-contract.js";
import { marketplaceCategoryTabs, marketplaceDetailPath, marketplaceStatisticItems, readMarketplaceDetailId } from "../src/marketplace-navigation.js";

describe("Pi Harness design contract", () => {
  it("keeps the workspace and session surfaces represented", () => {
    expect(DESIGN_WORKSPACES.length).toBeGreaterThanOrEqual(3);
    expect(DESIGN_SESSIONS.length).toBeGreaterThanOrEqual(6);
    expect(DESIGN_WORKSPACES.every((workspace) => workspace.path && workspace.branch && workspace.dirty)).toBe(true);
    expect(new Set(DESIGN_SESSIONS.map((session) => session.group))).toEqual(new Set(["今天", "昨天", "更早"]));
  });

  it("covers the event cards shown in the design", () => {
    expect(new Set(DESIGN_TURNS.map((turn) => turn.kind))).toEqual(
      new Set(["user", "reasoning", "plugin", "tool", "text", "approval", "subagent", "todo", "stats"]),
    );
    expect(DESIGN_EVENTS.some((event) => event.source === "plugin_hook")).toBe(true);
    expect(DESIGN_EVENTS.some((event) => event.source === "subagent")).toBe(true);
  });

  it("keeps package, provider and pi.toml content available to the UI", () => {
    expect(DESIGN_PLUGINS.length).toBeGreaterThanOrEqual(8);
    expect(DESIGN_PROVIDERS.map((provider) => provider.id)).toEqual(["deepseek", "anthropic"]);
    expect(DESIGN_TOML).toContain("[[packages]]");
    expect(DESIGN_TOML).toContain("[sandbox]");
  });

  it("uses a stable secondary route for marketplace details", () => {
    expect(marketplaceDetailPath("cordis-timer")).toBe("?page=marketplace&plugin=cordis-timer");
    expect(readMarketplaceDetailId(new URLSearchParams("page=marketplace&plugin=cordis-timer"))).toBe("cordis-timer");
    expect(readMarketplaceDetailId(new URLSearchParams("page=plugins&plugin=cordis-timer"))).toBeUndefined();
  });

  it("exposes a counted all-category tab before individual categories", () => {
    expect(
      marketplaceCategoryTabs([
        { id: "workflow", label: "工作流", count: 3 },
        { id: "security", label: "安全", count: 2 },
      ]),
    ).toEqual([
      { id: "", label: "全部", count: 5 },
      { id: "workflow", label: "工作流", count: 3 },
      { id: "security", label: "安全", count: 2 },
    ]);
  });

  it("labels npm statistics without presenting them as user ratings", () => {
    expect(marketplaceStatisticItems({ downloads30d: 1_014_632, quality: 0.923, updatedAt: "2026-08-30T13:14:00.557Z" })).toEqual([
      { label: "近 30 天下载量", value: "101.5 万" },
      { label: "npm 质量分", value: "92" },
      { label: "npm 更新时间", value: "2026-08-30" },
    ]);
    expect(marketplaceStatisticItems(undefined)).toEqual([]);
  });
});
