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
  readonly concurrency?: number;
  readonly failureMaxTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly fetcher?: MarketplaceStatisticsFetcher;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
}

export interface MarketplaceCachedStatistics {
  /** False until every catalogued package has been looked up once. A caller that reorders on statistics uses this to reorder once, when the set is complete, rather than on every poll while the background warm-up trickles in. */
  readonly ready: boolean;
  readonly statistics: ReadonlyMap<string, MarketplaceStatistics>;
}

export interface MarketplaceStatisticsLoader {
  (plugins: readonly MarketplacePlugin[]): Promise<ReadonlyMap<string, MarketplaceStatistics>>;
  // Returns only what is already cached and warms the misses in the background, so a request never waits on the npm registry.
  readonly readCached: (plugins: readonly MarketplacePlugin[]) => MarketplaceCachedStatistics;
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

export interface MarketplaceCapability {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

interface MarketplaceLocale {
  readonly categories: Readonly<Record<string, string>>;
  readonly capabilities: Readonly<Record<string, string>>;
  readonly hooks: Readonly<Record<string, string>>;
  readonly plugins: Readonly<Record<string, string>>;
}

/** What a plugin does to the machine it is installed on, ordered from the least invasive to the most, so a reader can decide from the badges alone. This replaced free text, which produced 299 values across 78 entries with 284 of them held by a single plugin: the filter listed nearly one option per plugin and nothing could be compared against anything else. Every value here is derived from the plugin's own imports, including those it inherits from a plugin it depends on. */
const MARKETPLACE_CAPABILITY_VOCABULARY: readonly { readonly id: string; readonly label: string }[] = [
  { id: "read-only", label: "只读运行" },
  { id: "session-data", label: "读取会话内容" },
  { id: "reads-files", label: "读取本机文件" },
  { id: "writes-files", label: "写入本机文件" },
  { id: "runs-commands", label: "执行本机命令" },
  { id: "local-server", label: "监听本地端口" },
  { id: "network-access", label: "访问网络" },
  { id: "model-calls", label: "额外调用模型" },
];

/** A badge that says a plugin changes nothing is a claim about trust, so an entry that also carries one of these is rejected rather than shown. */
const MARKETPLACE_EFFECT_CAPABILITIES: readonly string[] = ["writes-files", "runs-commands", "local-server", "network-access", "model-calls"];

const marketplaceCapabilityLabels = new Map(MARKETPLACE_CAPABILITY_VOCABULARY.map((capability) => [capability.id, capability.label]));

function isMarketplaceCapabilityList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const capabilities = value.filter((entry): entry is string => typeof entry === "string" && marketplaceCapabilityLabels.has(entry));
  if (capabilities.length !== value.length || new Set(capabilities).size !== capabilities.length) return false;
  return !capabilities.includes("read-only") || !capabilities.some((entry) => MARKETPLACE_EFFECT_CAPABILITIES.includes(entry));
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
    isMarketplaceCapabilityList(value.capabilities) &&
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
  // The category tabs are built from whichever entry is read first, so two entries that spell the same category differently would make the label depend on file order.
  const categoryLabels = new Map<string, string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) throw new Error(`Duplicate marketplace id: ${plugin.id}`);
    if (packages.has(plugin.packageName)) throw new Error(`Duplicate marketplace package: ${plugin.packageName}`);
    const categoryLabel = categoryLabels.get(plugin.category.id);
    if (categoryLabel !== undefined && categoryLabel !== plugin.category.label)
      throw new Error(`Conflicting marketplace category label for ${plugin.category.id}: ${categoryLabel} and ${plugin.category.label}`);
    ids.add(plugin.id);
    packages.add(plugin.packageName);
    categoryLabels.set(plugin.category.id, plugin.category.label);
  }
  return plugins;
}

export const MARKETPLACE_PLUGINS: readonly MarketplacePlugin[] = loadMarketplacePlugins();

function requiredStringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string" || entry.trim() === ""))
    throw new Error(`Invalid marketplace locale ${label}`);
  return value as Readonly<Record<string, string>>;
}

function requireExactLocaleKeys(actual: Readonly<Record<string, string>>, expected: ReadonlySet<string>, label: string): void {
  const actualKeys = new Set(Object.keys(actual));
  if (actualKeys.size !== expected.size || [...expected].some((key) => !actualKeys.has(key))) throw new Error(`Incomplete marketplace locale ${label}`);
}

function loadMarketplaceLocale(locale: string): MarketplaceLocale {
  const path = join(dirname(fileURLToPath(import.meta.url)), "marketplace-locales", `${locale}.json`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid marketplace locale ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`Invalid marketplace locale: ${path}`);
  const categories = requiredStringMap(value.categories, `${locale} categories`);
  const capabilities = requiredStringMap(value.capabilities, `${locale} capabilities`);
  const hooks = requiredStringMap(value.hooks, `${locale} hooks`);
  const plugins = requiredStringMap(value.plugins, `${locale} plugins`);
  requireExactLocaleKeys(categories, new Set(MARKETPLACE_PLUGINS.map((plugin) => plugin.category.id)), `${locale} categories`);
  requireExactLocaleKeys(capabilities, new Set(MARKETPLACE_CAPABILITY_VOCABULARY.map((capability) => capability.id)), `${locale} capabilities`);
  requireExactLocaleKeys(hooks, new Set(MARKETPLACE_PLUGINS.flatMap((plugin) => plugin.hooks)), `${locale} hooks`);
  requireExactLocaleKeys(plugins, new Set(MARKETPLACE_PLUGINS.map((plugin) => plugin.id)), `${locale} plugins`);
  return { categories, capabilities, hooks, plugins };
}

const MARKETPLACE_LOCALES = new Map<string, MarketplaceLocale>([["en", loadMarketplaceLocale("en")]]);

function localizeMarketplacePlugin(plugin: MarketplacePlugin, locale = ""): MarketplacePlugin {
  const catalog = MARKETPLACE_LOCALES.get(locale);
  if (catalog === undefined) return plugin;
  return {
    ...plugin,
    description: catalog.plugins[plugin.id] ?? plugin.description,
    category: { ...plugin.category, label: catalog.categories[plugin.category.id] ?? plugin.category.label },
    hooks: plugin.hooks.map((hook) => catalog.hooks[hook] ?? hook),
  };
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

export function createMarketplaceStatisticsLoader(options: MarketplaceStatisticsLoaderOptions = {}): MarketplaceStatisticsLoader {
  const fetcher = options.fetcher ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const failureTtlMs = options.failureTtlMs ?? 60_000;
  // Consecutive failures double the retry window up to this ceiling: an open console polls the catalog every few seconds, so a flat failure window would send one registry lookup per catalogued package every minute for as long as the tab stays open.
  const failureMaxTtlMs = options.failureMaxTtlMs ?? 30 * 60_000;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1_000;
  // The registry answers an unthrottled fan-out over the whole catalogue with 429s, so lookups queue behind a small number of slots instead of leaving at once.
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 4));
  const cache = new Map<string, { readonly expiresAt: number; readonly failures: number; readonly result: NpmPackageStatisticsResult }>();
  const inFlight = new Map<string, Promise<NpmPackageStatisticsResult>>();
  const waiting: (() => void)[] = [];
  let active = 0;
  const acquireSlot = async (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolveSlot) => waiting.push(resolveSlot));
  };
  const releaseSlot = (): void => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  const failureTtl = (failures: number): number => Math.min(failureTtlMs * 2 ** Math.min(failures - 1, 20), failureMaxTtlMs);
  const loadPackage = async (packageName: string): Promise<NpmPackageStatisticsResult> => {
    const timestamp = now();
    const cached = cache.get(packageName);
    if (cached !== undefined && cached.expiresAt > timestamp) return cached.result;
    const pending = inFlight.get(packageName);
    if (pending !== undefined) return pending;
    // The slot is taken inside the promise so the in-flight entry is still registered synchronously and concurrent callers keep sharing one request.
    const request = (async () => {
      await acquireSlot();
      try {
        return await fetchNpmPackageStatistics(packageName, fetcher, timeoutMs);
      } finally {
        releaseSlot();
      }
    })();
    inFlight.set(packageName, request);
    try {
      const result = await request;
      const failures = result.failed ? (cached?.failures ?? 0) + 1 : 0;
      cache.set(packageName, { expiresAt: now() + (result.failed ? failureTtl(failures) : ttlMs), failures, result });
      return result;
    } finally {
      if (inFlight.get(packageName) === request) inFlight.delete(packageName);
    }
  };
  const packageNames = (plugins: readonly MarketplacePlugin[]): readonly string[] =>
    [...new Set(plugins.map((plugin) => marketplaceNpmPackageName(plugin.packageName)))].sort();
  const load = async (plugins: readonly MarketplacePlugin[]): Promise<ReadonlyMap<string, MarketplaceStatistics>> => {
    const entries = await Promise.all(packageNames(plugins).map(async (packageName) => [packageName, await loadPackage(packageName)] as const));
    return new Map(entries.flatMap(([packageName, result]) => (result.statistics === undefined ? [] : [[packageName, result.statistics] as const])));
  };
  const readCached = (plugins: readonly MarketplacePlugin[]): MarketplaceCachedStatistics => {
    const timestamp = now();
    const statistics = new Map<string, MarketplaceStatistics>();
    // Readiness tracks whether a package has ever been looked up, not whether its entry is fresh, so an expiring entry refreshes in the background without dropping the catalogue back to an unsorted order.
    let ready = true;
    for (const packageName of packageNames(plugins)) {
      const cached = cache.get(packageName);
      if (cached === undefined) ready = false;
      if (cached !== undefined && cached.expiresAt > timestamp) {
        if (cached.result.statistics !== undefined) statistics.set(packageName, cached.result.statistics);
        continue;
      }
      // A prewarm has nobody to report to, and a catalogue sorted without npm statistics is not worth crashing the process over an unhandled rejection.
      void loadPackage(packageName).catch(() => {});
    }
    return { ready, statistics };
  };
  return Object.assign(load, { readCached });
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

export function searchMarketplace(query = "", capability = "", category = "", locale = ""): readonly MarketplacePlugin[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedCapability = capability.trim().toLowerCase();
  const normalizedCategory = category.trim().toLowerCase();
  return MARKETPLACE_PLUGINS.map((plugin) => ({ source: plugin, localized: localizeMarketplacePlugin(plugin, locale) }))
    .filter(({ source, localized }) => {
      // The capability labels are searched alongside their ids: the ids are what the filter and the URL carry, and the labels are what the reader sees on the card.
      const localeCatalog = MARKETPLACE_LOCALES.get(locale);
      const capabilities = source.capabilities.flatMap((item) => [
        item,
        marketplaceCapabilityLabels.get(item) ?? item,
        localeCatalog?.capabilities[item] ?? item,
      ]);
      const searchable = [
        source.name,
        source.packageName,
        source.description,
        localized.description,
        source.author,
        source.category.id,
        localized.category.label,
        ...capabilities,
        ...source.hooks,
        ...localized.hooks,
      ]
        .join(" ")
        .toLowerCase();
      return (
        (normalizedQuery === "" || searchable.includes(normalizedQuery)) &&
        (normalizedCapability === "" || source.capabilities.some((item) => item.toLowerCase() === normalizedCapability)) &&
        (normalizedCategory === "" || source.category.id.toLowerCase() === normalizedCategory)
      );
    })
    .map(({ localized }) => localized);
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

// Kept in vocabulary order rather than sorted, so the filter reads from the least invasive option to the most, and an unused capability is left out rather than offering a filter that returns nothing.
export const MARKETPLACE_CAPABILITIES: readonly MarketplaceCapability[] = MARKETPLACE_CAPABILITY_VOCABULARY.map((capability) => ({
  ...capability,
  count: MARKETPLACE_PLUGINS.filter((plugin) => plugin.capabilities.includes(capability.id)).length,
})).filter((capability) => capability.count > 0);
export const MARKETPLACE_CATEGORIES: readonly MarketplaceCategory[] = [
  ...new Map(MARKETPLACE_PLUGINS.map((plugin) => [plugin.category.id, { id: plugin.category.id, label: plugin.category.label, count: 0 }])).values(),
]
  .map((category) => ({ ...category, count: MARKETPLACE_PLUGINS.filter((plugin) => plugin.category.id === category.id).length }))
  .sort((a, b) => a.label.localeCompare(b.label));

export function marketplaceCapabilities(locale = ""): readonly MarketplaceCapability[] {
  const catalog = MARKETPLACE_LOCALES.get(locale);
  if (catalog === undefined) return MARKETPLACE_CAPABILITIES;
  return MARKETPLACE_CAPABILITIES.map((capability) => ({ ...capability, label: catalog.capabilities[capability.id] ?? capability.label }));
}

export function marketplaceCategories(locale = ""): readonly MarketplaceCategory[] {
  const catalog = MARKETPLACE_LOCALES.get(locale);
  if (catalog === undefined) return MARKETPLACE_CATEGORIES;
  return MARKETPLACE_CATEGORIES.map((category) => ({ ...category, label: catalog.categories[category.id] ?? category.label })).sort((left, right) =>
    left.label.localeCompare(right.label, locale),
  );
}
