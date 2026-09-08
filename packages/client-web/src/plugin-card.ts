import type { ClientMarketplacePlugin, ClientPlugin } from "./control-room.js";

export interface InstalledPluginCardContent {
  readonly packageLabel: string;
  readonly description: string;
  readonly tags: readonly string[];
}

/** `capabilityLabel` is the same labeller the marketplace grid uses, so one capability reads the same on both tabs instead of appearing as its raw id here and its label there. */
export function installedPluginCardContent(
  plugin: ClientPlugin,
  metadata: ClientMarketplacePlugin | undefined,
  capabilityLabel: (id: string) => string,
): InstalledPluginCardContent {
  if (metadata) {
    return {
      packageLabel: `${plugin.name} · v${metadata.version}`,
      description: metadata.description,
      tags: [...metadata.capabilities.map(capabilityLabel), ...metadata.hooks.map((hook) => `hook:${hook}`)],
    };
  }
  return {
    packageLabel: plugin.name,
    description: plugin.enabled ? "由当前运行时加载并启用，能力与 hook 已注册。" : "由当前运行时加载但已停用。",
    tags: ["loader", plugin.state === "active" ? "active" : `state:${plugin.state}`],
  };
}
