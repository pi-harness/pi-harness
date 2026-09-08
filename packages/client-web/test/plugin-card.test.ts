import { describe, expect, it } from "vitest";
import type { ClientMarketplacePlugin, ClientPlugin } from "../src/control-room.js";
import { installedPluginCardContent } from "../src/plugin-card.js";

const plugin: ClientPlugin = {
  id: "agent-teams",
  name: "@pi-harness/plugin-agent-teams",
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

const capabilityLabel = (id: string): string => ({ "multi-agent": "多 Agent", tasks: "任务" })[id] ?? id;

describe("installed plugin card content", () => {
  it("uses the same marketplace metadata as the detail surface", () => {
    expect(installedPluginCardContent(plugin, metadata, capabilityLabel)).toEqual({
      packageLabel: `${plugin.name} · v1.2.3`,
      description: metadata.description,
      tags: ["多 Agent", "任务", "hook:session lifecycle"],
    });
  });

  // A capability the catalog does not label still has to render as something, and its id is the only honest thing left to show.
  it("falls back to the capability id when the catalog carries no label for it", () => {
    expect(installedPluginCardContent(plugin, { ...metadata, capabilities: ["unknown-capability"] }, capabilityLabel).tags).toEqual([
      "unknown-capability",
      "hook:session lifecycle",
    ]);
  });

  it("keeps an explicit runtime fallback for plugins without catalog metadata", () => {
    expect(installedPluginCardContent({ ...plugin, enabled: false, state: "disabled" }, undefined, capabilityLabel)).toEqual({
      packageLabel: plugin.name,
      description: "由当前运行时加载但已停用。",
      tags: ["loader", "state:disabled"],
    });
  });
});
