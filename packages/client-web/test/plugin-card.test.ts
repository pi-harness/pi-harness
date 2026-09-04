import { describe, expect, it } from "vitest";
import type { ClientMarketplacePlugin, ClientPlugin } from "../src/control-room.js";
import { installedPluginCardContent } from "../src/plugin-card.js";

const plugin: ClientPlugin = {
  id: "agent-teams",
  name: "@pi-harness/core/plugins/agent-teams",
  enabled: true,
  state: "active",
  removable: true,
};

const metadata: ClientMarketplacePlugin = {
  id: "agent-teams",
  packageName: plugin.name,
  version: "1.2.3",
  name: "Agent Teams",
  description: "Coordinate multiple named agents with durable tasks.",
  author: "Pi Harness",
  repository: "https://github.com/pi-harness/pi-harness",
  license: "MIT",
  source: "official",
  status: "verified",
  category: { id: "collaboration", label: "多 Agent 协作" },
  capabilities: ["multi-agent", "tasks"],
  hooks: ["session lifecycle"],
  profile: { name: plugin.name, config: {} },
};

describe("installed plugin card content", () => {
  it("uses the same marketplace metadata as the detail surface", () => {
    expect(installedPluginCardContent(plugin, metadata)).toEqual({
      packageLabel: `${plugin.name} · v1.2.3`,
      description: metadata.description,
      tags: ["multi-agent", "tasks", "hook:session lifecycle"],
    });
  });

  it("keeps an explicit runtime fallback for plugins without catalog metadata", () => {
    expect(installedPluginCardContent({ ...plugin, enabled: false, state: "disabled" }, undefined)).toEqual({
      packageLabel: plugin.name,
      description: "由当前运行时加载但已停用。",
      tags: ["loader", "state:disabled"],
    });
  });
});
