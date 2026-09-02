import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  readonly category: { readonly id: string; readonly label: string };
  readonly capabilities: readonly string[];
  readonly hooks: readonly string[];
  readonly profile: { readonly name: string; readonly config: Record<string, unknown> | readonly unknown[]; readonly group?: boolean };
}

export interface MarketplacePage {
  readonly items: readonly MarketplacePlugin[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
}

export interface MarketplaceCategory {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

const npmPackagePattern = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)*$/;
const entryIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const categoryIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMarketplacePlugin(value: unknown): value is MarketplacePlugin {
  if (!isRecord(value)) return false;
  const profile = value.profile;
  const category = value.category;
  return (
    typeof value.id === "string" &&
    entryIdPattern.test(value.id) &&
    typeof value.packageName === "string" &&
    npmPackagePattern.test(value.packageName) &&
    typeof value.version === "string" &&
    versionPattern.test(value.version) &&
    typeof value.name === "string" &&
    value.name.trim() !== "" &&
    typeof value.description === "string" &&
    value.description.trim() !== "" &&
    typeof value.author === "string" &&
    value.author.trim() !== "" &&
    typeof value.repository === "string" &&
    value.repository.startsWith("https://") &&
    typeof value.license === "string" &&
    value.license.trim() !== "" &&
    (value.source === "official" || value.source === "community") &&
    (value.status === "verified" || value.status === "experimental") &&
    isRecord(category) &&
    typeof category.id === "string" &&
    categoryIdPattern.test(category.id) &&
    typeof category.label === "string" &&
    category.label.trim() !== "" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length > 0 &&
    value.capabilities.every((entry) => typeof entry === "string" && entry.trim() !== "") &&
    Array.isArray(value.hooks) &&
    value.hooks.length > 0 &&
    value.hooks.every((entry) => typeof entry === "string" && entry.trim() !== "") &&
    isRecord(profile) &&
    typeof profile.name === "string" &&
    profile.name === value.packageName &&
    (profile.group !== true ? isRecord(profile.config) : Array.isArray(profile.config))
  );
}

function entryFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entryFiles(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  });
}

function loadMarketplacePlugins(): readonly MarketplacePlugin[] {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "marketplace-entries");
  const plugins = entryFiles(directory)
    .sort()
    .map((path) => {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch (error) {
        throw new Error(`Invalid marketplace entry ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (!isMarketplacePlugin(value)) throw new Error(`Invalid marketplace entry: ${path}`);
      return value;
    });
  const ids = new Set<string>();
  const packages = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) throw new Error(`Duplicate marketplace id: ${plugin.id}`);
    if (packages.has(plugin.packageName)) throw new Error(`Duplicate marketplace package: ${plugin.packageName}`);
    ids.add(plugin.id);
    packages.add(plugin.packageName);
  }
  return plugins;
}

export const MARKETPLACE_PLUGINS: readonly MarketplacePlugin[] = loadMarketplacePlugins();

export function needsMarketplacePackageInstall(plugin: MarketplacePlugin): boolean {
  return !plugin.packageName.startsWith("@pi-harness/core/plugins/");
}

export function searchMarketplace(query = "", capability = "", category = ""): readonly MarketplacePlugin[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedCapability = capability.trim().toLowerCase();
  const normalizedCategory = category.trim().toLowerCase();
  return MARKETPLACE_PLUGINS.filter((plugin) => {
    const searchable = [plugin.name, plugin.packageName, plugin.description, plugin.author, ...plugin.capabilities, ...plugin.hooks].join(" ").toLowerCase();
    return (
      (normalizedQuery === "" || searchable.includes(normalizedQuery)) &&
      (normalizedCapability === "" || plugin.capabilities.some((item) => item.toLowerCase() === normalizedCapability)) &&
      (normalizedCategory === "" || plugin.category.id.toLowerCase() === normalizedCategory)
    );
  });
}

export function paginateMarketplace(items: readonly MarketplacePlugin[], page = 0, pageSize = 24): MarketplacePage {
  const normalizedPageSize = Math.min(Math.max(Math.trunc(pageSize) || 24, 1), 100);
  const normalizedPage = Math.max(Math.trunc(page) || 0, 0);
  const start = normalizedPage * normalizedPageSize;
  return {
    items: items.slice(start, start + normalizedPageSize),
    total: items.length,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    hasNext: start + normalizedPageSize < items.length,
  };
}

export const MARKETPLACE_CAPABILITIES = [...new Set(MARKETPLACE_PLUGINS.flatMap((plugin) => plugin.capabilities))].sort();
export const MARKETPLACE_CATEGORIES: readonly MarketplaceCategory[] = [
  ...new Map(MARKETPLACE_PLUGINS.map((plugin) => [plugin.category.id, { id: plugin.category.id, label: plugin.category.label, count: 0 }])).values(),
]
  .map((category) => ({ ...category, count: MARKETPLACE_PLUGINS.filter((plugin) => plugin.category.id === category.id).length }))
  .sort((a, b) => a.label.localeCompare(b.label));
