import { describe, expect, it } from "vitest";
import { DESIGN_EVENTS, DESIGN_PLUGINS, DESIGN_SESSIONS, DESIGN_WORKSPACES, DESIGN_TURNS, DESIGN_PROVIDERS, DESIGN_TOML } from "../src/design-contract.js";

describe("Pi Harness design contract", () => {
  it("keeps the workspace and session surfaces represented", () => {
    expect(DESIGN_WORKSPACES.length).toBeGreaterThanOrEqual(3);
    expect(DESIGN_SESSIONS.length).toBeGreaterThanOrEqual(6);
    expect(DESIGN_WORKSPACES.every((workspace) => workspace.path && workspace.branch && workspace.dirty)).toBe(true);
    expect(new Set(DESIGN_SESSIONS.map((session) => session.group))).toEqual(new Set(["今天", "昨天", "更早"]));
  });

  it("covers the event cards shown in the design", () => {
    expect(new Set(DESIGN_TURNS.map((turn) => turn.kind))).toEqual(new Set(["user", "reasoning", "plugin", "tool", "text", "approval", "subagent", "todo", "stats"]));
    expect(DESIGN_EVENTS.some((event) => event.source === "plugin_hook")).toBe(true);
    expect(DESIGN_EVENTS.some((event) => event.source === "subagent")).toBe(true);
  });

  it("keeps package, provider and pi.toml content available to the UI", () => {
    expect(DESIGN_PLUGINS.length).toBeGreaterThanOrEqual(8);
    expect(DESIGN_PROVIDERS.map((provider) => provider.id)).toEqual(["deepseek", "anthropic"]);
    expect(DESIGN_TOML).toContain("[[packages]]");
    expect(DESIGN_TOML).toContain("[sandbox]");
  });
});
