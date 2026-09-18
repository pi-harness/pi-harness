import type { ClientMarketplacePlugin, ClientPlugin } from "./control-room.js";
import { t } from "./i18n.js";

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
      // The catalogue's version is the one an install would pin today, not the one this machine installed; printing the pin made every card claim a version that had drifted out from under it.
      packageLabel: `${plugin.name} · v${plugin.installedVersion ?? metadata.version}`,
      description: metadata.description,
      tags: [...metadata.capabilities.map(capabilityLabel), ...metadata.hooks.map((hook) => `hook:${hook}`)],
    };
  }
  return {
    packageLabel: plugin.name,
    description: plugin.enabled ? t("由当前运行时加载并启用，能力与 hook 已注册。") : t("由当前运行时加载但已停用。"),
    tags: ["loader", plugin.state === "active" ? "active" : `state:${plugin.state}`],
  };
}
