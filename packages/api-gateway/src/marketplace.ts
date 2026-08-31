import registry from "./marketplace-registry.json" with { type: "json" };

export interface MarketplacePlugin {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  readonly repository: string;
  readonly license: string;
  readonly source: "official" | "community";
  readonly status: "verified" | "experimental";
  readonly capabilities: readonly string[];
  readonly hooks: readonly string[];
  readonly profile: { readonly name: string; readonly config: Record<string, unknown> };
}

const npmPackagePattern = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/;

function isMarketplacePlugin(value: unknown): value is MarketplacePlugin {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<MarketplacePlugin>;
  return typeof item.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)
    && typeof item.packageName === "string" && npmPackagePattern.test(item.packageName)
    && typeof item.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.version)
    && typeof item.name === "string" && typeof item.description === "string" && typeof item.author === "string"
    && typeof item.repository === "string" && item.repository.startsWith("https://") && typeof item.license === "string"
    && (item.source === "official" || item.source === "community") && (item.status === "verified" || item.status === "experimental")
    && Array.isArray(item.capabilities) && item.capabilities.every((entry) => typeof entry === "string")
    && Array.isArray(item.hooks) && item.hooks.every((entry) => typeof entry === "string")
    && item.profile !== undefined && typeof item.profile === "object" && typeof item.profile.name === "string"
    && item.profile.config !== undefined && typeof item.profile.config === "object";
}

export const MARKETPLACE_PLUGINS: readonly MarketplacePlugin[] = (registry as unknown[]).filter(isMarketplacePlugin);

export function searchMarketplace(query = "", capability = ""): readonly MarketplacePlugin[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedCapability = capability.trim().toLowerCase();
  return MARKETPLACE_PLUGINS.filter((plugin) => {
    const searchable = [plugin.name, plugin.packageName, plugin.description, plugin.author, ...plugin.capabilities, ...plugin.hooks].join(" ").toLowerCase();
    return (normalizedQuery === "" || searchable.includes(normalizedQuery))
      && (normalizedCapability === "" || plugin.capabilities.some((item) => item.toLowerCase() === normalizedCapability));
  });
}

export const MARKETPLACE_CAPABILITIES = [...new Set(MARKETPLACE_PLUGINS.flatMap((plugin) => plugin.capabilities))].sort();
