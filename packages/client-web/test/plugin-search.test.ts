import { describe, expect, it } from "vitest";
import { matchesPluginQuery } from "../src/plugin-search.js";

describe("installed plugin search", () => {
  const fields = ["@pi-harness/core/plugins/docker-sandbox", "Docker Sandbox", "安全", "沙箱"];

  it("matches package, display name, category, and capability without case sensitivity", () => {
    expect(matchesPluginQuery("docker", fields)).toBe(true);
    expect(matchesPluginQuery("DOCKER SANDBOX", fields)).toBe(true);
    expect(matchesPluginQuery("安全", fields)).toBe(true);
    expect(matchesPluginQuery("沙箱", fields)).toBe(true);
  });

  it("trims the query and keeps the complete list visible for an empty query", () => {
    expect(matchesPluginQuery("  docker  ", fields)).toBe(true);
    expect(matchesPluginQuery("   ", fields)).toBe(true);
  });

  it("rejects unrelated plugins", () => {
    expect(matchesPluginQuery("session export", fields)).toBe(false);
  });
});
