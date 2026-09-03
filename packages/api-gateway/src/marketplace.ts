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
  readonly statistics?: MarketplaceStatistics;
}

export interface MarketplaceStatistics {
  readonly downloads30d?: number;
  readonly quality?: number;
  readonly updatedAt?: string;
}

export type MarketplaceStatisticsFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface MarketplaceStatisticsLoaderOptions {
  readonly failureTtlMs?: number;
  readonly fetcher?: MarketplaceStatisticsFetcher;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
}

interface NpmPackageStatisticsResult {
  readonly failed: boolean;
  readonly statistics?: MarketplaceStatistics;
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

export function marketplaceNpmPackageName(packageName: string): string {
  const segments = packageName.split("/");
  return packageName.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? packageName);
}

function validUnitScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function fetchNpmPackageStatistics(packageName: string, fetcher: MarketplaceStatisticsFetcher, timeoutMs: number): Promise<NpmPackageStatisticsResult> {
  let searchResponse: Response;
  try {
    const query = new URLSearchParams({ text: packageName, size: "20" });
    searchResponse = await fetcher(`https://registry.npmjs.org/-/v1/search?${query}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { failed: true };
  }
  if (!searchResponse.ok) return { failed: true };
  let searchPayload: unknown;
  try {
    searchPayload = (await searchResponse.json()) as unknown;
  } catch {
    return { failed: true };
  }
  if (!isRecord(searchPayload) || !Array.isArray(searchPayload.objects)) return { failed: true };
  const objects: unknown[] = searchPayload.objects;
  const exact: unknown = objects.find((item) => isRecord(item) && isRecord(item.package) && item.package.name === packageName);
  if (!isRecord(exact) || !isRecord(exact.package)) return { failed: false };
  const detail = isRecord(exact.score) && isRecord(exact.score.detail) ? exact.score.detail : undefined;
  const statistics: { downloads30d?: number; quality?: number; updatedAt?: string } = {};
  if (detail && validUnitScore(detail.quality)) statistics.quality = detail.quality;
  if (validDate(exact.package.date)) statistics.updatedAt = exact.package.date;
  let failed = false;
  try {
    const downloadResponse = await fetcher(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(packageName)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (downloadResponse.ok) {
      const downloadPayload = (await downloadResponse.json()) as unknown;
      if (
        isRecord(downloadPayload) &&
        typeof downloadPayload.downloads === "number" &&
        Number.isSafeInteger(downloadPayload.downloads) &&
        downloadPayload.downloads >= 0
      )
        statistics.downloads30d = downloadPayload.downloads;
      else failed = true;
    } else failed = true;
  } catch {
    // Download counts are optional when the npm statistics service is unavailable.
    failed = true;
  }
  return { failed, statistics };
}

export function createMarketplaceStatisticsLoader(options: MarketplaceStatisticsLoaderOptions = {}) {
  const fetcher = options.fetcher ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const failureTtlMs = options.failureTtlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1_000;
  let cached: { readonly key: string; readonly expiresAt: number; readonly value: ReadonlyMap<string, MarketplaceStatistics> } | undefined;
  let inFlight:
    | { readonly key: string; readonly value: Promise<{ readonly failed: boolean; readonly statistics: ReadonlyMap<string, MarketplaceStatistics> }> }
    | undefined;
  return async (plugins: readonly MarketplacePlugin[]): Promise<ReadonlyMap<string, MarketplaceStatistics>> => {
    const packageNames = [...new Set(plugins.map((plugin) => marketplaceNpmPackageName(plugin.packageName)))].sort();
    const key = packageNames.join("\n");
    const timestamp = now();
    if (cached?.key === key && cached.expiresAt > timestamp) return cached.value;
    if (inFlight?.key === key) return (await inFlight.value).statistics;
    const value = Promise.all(
      packageNames.map(async (packageName) => [packageName, await fetchNpmPackageStatistics(packageName, fetcher, timeoutMs)] as const),
    ).then((entries) => ({
      failed: entries.some(([, result]) => result.failed),
      statistics: new Map(
        entries
          .filter(
            (entry): entry is readonly [string, NpmPackageStatisticsResult & { readonly statistics: MarketplaceStatistics }] =>
              entry[1].statistics !== undefined,
          )
          .map(([packageName, result]) => [packageName, result.statistics]),
      ),
    }));
    inFlight = { key, value };
    try {
      const result = await value;
      cached = { key, expiresAt: timestamp + (result.failed ? failureTtlMs : ttlMs), value: result.statistics };
      return result.statistics;
    } finally {
      if (inFlight?.value === value) inFlight = undefined;
    }
  };
}

export function attachMarketplaceStatistics(
  plugins: readonly MarketplacePlugin[],
  statistics: ReadonlyMap<string, MarketplaceStatistics>,
): readonly MarketplacePlugin[] {
  return plugins.map((plugin) => {
    const value = statistics.get(marketplaceNpmPackageName(plugin.packageName));
    return value === undefined ? plugin : { ...plugin, statistics: value };
  });
}

function marketplaceRecommendationScore(plugin: MarketplacePlugin, now: number): number {
  const verified = plugin.status === "verified" ? 40 : 0;
  const quality = (plugin.statistics?.quality ?? 0) * 30;
  const downloads = Math.min(Math.log10((plugin.statistics?.downloads30d ?? 0) + 1) / 7, 1) * 20;
  const updatedAt = plugin.statistics?.updatedAt === undefined ? undefined : Date.parse(plugin.statistics.updatedAt);
  const ageDays = updatedAt === undefined || !Number.isFinite(updatedAt) ? Number.POSITIVE_INFINITY : Math.max(0, now - updatedAt) / 86_400_000;
  const recency = Math.max(0, 1 - ageDays / 365) * 10;
  return verified + quality + downloads + recency;
}

export function sortMarketplaceByRecommendation(plugins: readonly MarketplacePlugin[], now = Date.now()): readonly MarketplacePlugin[] {
  return [...plugins].sort((left, right) => marketplaceRecommendationScore(right, now) - marketplaceRecommendationScore(left, now));
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
