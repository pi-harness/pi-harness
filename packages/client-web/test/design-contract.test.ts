import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { failedRefreshLabels } from "../src/control-room.js";
import { DESIGN_EVENTS, DESIGN_PLUGINS, DESIGN_SESSIONS, DESIGN_WORKSPACES, DESIGN_TURNS, DESIGN_PROVIDERS, DESIGN_TOML } from "../src/design-contract.js";
import {
  marketplaceCapabilityLabeller,
  marketplaceCategoryTabs,
  marketplaceDetailPath,
  marketplaceStatisticItems,
  readMarketplaceDetailId,
} from "../src/marketplace-navigation.js";

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

  it("names a capability the way the catalogue does and falls back to the raw id", () => {
    const label = marketplaceCapabilityLabeller([
      { id: "read-only", label: "只读运行" },
      { id: "runs-commands", label: "执行本机命令" },
    ]);
    expect(label("read-only")).toBe("只读运行");
    expect(label("runs-commands")).toBe("执行本机命令");
    // An id the catalogue has not described yet reads as itself rather than as a blank chip, which is what the moment before the first response looks like.
    expect(label("writes-files")).toBe("writes-files");
    expect(marketplaceCapabilityLabeller([])("read-only")).toBe("read-only");
  });

  it("labels npm statistics without presenting them as user ratings", () => {
    expect(marketplaceStatisticItems({ downloads30d: 1_014_632, quality: 0.923, updatedAt: "2026-08-30T13:14:00.557Z" })).toEqual([
      { label: "近 30 天下载量", value: "101.5万" },
      { label: "npm 质量分", value: "92" },
      { label: "npm 更新时间", value: "2026-08-30" },
    ]);
    expect(marketplaceStatisticItems(undefined)).toEqual([]);
  });

  // The console header and the plugin detail pane are written inline inside ControlRoom, which cannot be
  // mounted without booting the whole room, so the heading outline is asserted against the source instead.
  it("gives every view a single top-level heading", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/react-room.tsx", import.meta.url)), "utf8");
    const headings = source.match(/<h[1-6][\s>]/g) ?? [];
    const levelOne = headings.filter((tag) => tag.startsWith("<h1"));

    // One h1 in the file: the page title in the header, rendered on the session, plugin, marketplace and settings views.
    expect(levelOne).toHaveLength(1);
    expect(source).toContain('<div className="active-heading">\n            <h1>');

    // The plugin detail pane sits under that title, so its own heading is an h2 and its sections are h3.
    expect(source).not.toMatch(/<h2 className="text-\[13px\] font-semibold/);
    expect(source.match(/<h2 className="text-3xl font-semibold/g) ?? []).toHaveLength(2);
    expect((source.match(/<h3 className="text-\[13px\] font-semibold/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("styles the header title by tag so it carries no browser default margin", () => {
    const styles = readFileSync(fileURLToPath(new URL("../../../apps/web/src/style.css", import.meta.url)), "utf8");
    expect(styles).not.toContain(".active-heading strong");
    expect(styles).toContain(".active-heading h1");
    expect(styles).toMatch(/\.active-heading h1 \{\n\s*@apply \[margin:0\]/);
  });

  it("formats every number in the console for the active language", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/react-room.tsx", import.meta.url)), "utf8");

    // A hard-coded locale groups 110121 as "110,121" in a German or French UI, where the language wants
    // "110.121" and "110 121". A bare call follows the browser instead of the language the console is set to.
    expect(source).not.toMatch(/toLocaleString\(\s*"/);
    expect(source).not.toMatch(/toLocaleString\(\s*\)/);
    expect(source).not.toMatch(/Intl\.(?:Number|DateTime|RelativeTime)Format\(\s*[")]/);
    expect((source.match(/toLocaleString\(formatLocale\(\)\)/g) ?? []).length).toBeGreaterThanOrEqual(26);
  });

  it("exposes an active control's state to assistive technology, not only to CSS", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/react-room.tsx", import.meta.url)), "utf8");
    const buttons = source.match(/<button\b[^>]*>/gs) ?? [];
    const activeButtons = buttons.filter((tag) => /\bactive\b/.test(tag));

    // A control that shows it is on by swapping a class says nothing to a screen reader: the trace filters
    // read as plain buttons with no indication of which one is applied. A toggle carries aria-pressed; the
    // current item in a set of pages carries aria-current.
    expect(activeButtons.length).toBeGreaterThanOrEqual(14);
    const silent = activeButtons.filter((tag) => !/aria-pressed|aria-current/.test(tag));
    expect(silent).toEqual([]);
  });

  it("reports every failed control-room refresh surface without hiding partial failures", () => {
    expect(
      failedRefreshLabels(
        ["status", "session", "plugins"],
        [
          { status: "fulfilled", value: {} },
          { status: "rejected", reason: new Error("offline") },
          { status: "rejected", reason: new Error("timeout") },
        ],
      ),
    ).toEqual(["session", "plugins"]);
  });
});
