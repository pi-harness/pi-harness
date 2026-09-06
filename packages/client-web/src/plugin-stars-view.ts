export interface PluginStarsRowInput {
  readonly fullName: string;
  readonly name: string;
  readonly stars: number;
  readonly htmlUrl: string;
  readonly updatedAt: string;
}

export interface PluginStarsRow extends PluginStarsRowInput {
  readonly rank: number;
}

export interface PluginStarsPanelView {
  readonly source: string;
  readonly limit: number;
  readonly timeoutMs: number;
  readonly latest: {
    readonly source: string;
    readonly generatedAt: string;
    readonly total: number;
    readonly query: string;
    readonly fetchedAt: string;
    readonly results: readonly PluginStarsRow[];
  } | null;
  readonly inventory: { readonly total: number; readonly shown: number; readonly truncated: boolean };
  readonly limits: {
    readonly responseBytes: number;
    readonly sourceItems: number;
    readonly resultItems: number;
    readonly panelItems: number;
    readonly queryCharacters: number;
    readonly timeoutMs: number;
  };
  readonly malformed: boolean;
}

const visibleRows = 8;
const defaults = {
  limit: 10,
  timeoutMs: 15_000,
  responseBytes: 2 * 1024 * 1024,
  sourceItems: 1_000,
  resultItems: 50,
  panelItems: 20,
  queryCharacters: 120,
} as const;
const rootKeys = new Set(["source", "limit", "timeoutMs", "latest", "inventory", "limits"]);
const latestKeys = new Set(["source", "generatedAt", "total", "query", "fetchedAt", "results"]);
const inventoryKeys = new Set(["total", "shown", "truncated"]);
const limitsKeys = new Set(["responseBytes", "sourceItems", "resultItems", "panelItems", "queryCharacters", "timeoutMs"]);
const rowKeys = new Set(["id", "name", "fullName", "description", "htmlUrl", "homepage", "npmName", "stars", "updatedAt", "license", "topics"]);
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function exact(source: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const own = Object.keys(source);
  return own.length === keys.size && own.every((key) => keys.has(key));
}

function ownDataArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const lengthDescriptor = descriptors.length;
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) return undefined;
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= (length as number) || String(Number(key)) !== key),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function text(value: unknown, maximum: number, allowEmpty = true): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || unsafeUnicode.test(value)) return undefined;
  if ([...value].length > maximum || new TextEncoder().encode(value).byteLength > maximum) return undefined;
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function row(value: unknown): PluginStarsRowInput | undefined {
  const source = ownDataRecord(value, rowKeys);
  if (source === undefined) return undefined;
  const fullName = text(source.fullName, 512, false);
  const name = text(source.name, 256, false);
  const htmlUrl = text(source.htmlUrl, 4_096, false);
  const updatedAt = text(source.updatedAt, 64);
  const stars = integer(source.stars, 0, Number.MAX_SAFE_INTEGER);
  if (
    fullName === undefined ||
    name === undefined ||
    htmlUrl === undefined ||
    updatedAt === undefined ||
    stars === undefined ||
    !/^[^/\s]+\/[^/\s]+$/u.test(fullName)
  )
    return undefined;
  let repositoryUrl: URL;
  try {
    repositoryUrl = new URL(htmlUrl);
  } catch {
    return undefined;
  }
  if (
    repositoryUrl.protocol !== "https:" ||
    repositoryUrl.hostname.toLowerCase() !== "github.com" ||
    repositoryUrl.username !== "" ||
    repositoryUrl.password !== "" ||
    repositoryUrl.port !== "" ||
    repositoryUrl.search !== "" ||
    repositoryUrl.hash !== "" ||
    repositoryUrl.pathname.replace(/\/$/u, "").toLowerCase() !== `/${fullName}`.toLowerCase()
  )
    return undefined;
  return { fullName, name, stars, htmlUrl: repositoryUrl.toString(), updatedAt };
}

export function pluginStarsRows(entries: readonly PluginStarsRowInput[], limit: number): readonly PluginStarsRow[] {
  const normalizedLimit = Math.max(0, Math.min(50, Math.trunc(limit)));
  return entries
    .slice(0, 64)
    .map(row)
    .filter((entry): entry is PluginStarsRowInput => entry !== undefined)
    .sort((left, right) => right.stars - left.stars || left.fullName.localeCompare(right.fullName))
    .slice(0, normalizedLimit)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function limitsView(value: unknown): PluginStarsPanelView["limits"] | undefined {
  const source = ownDataRecord(value, limitsKeys);
  if (source === undefined || !exact(source, limitsKeys)) return undefined;
  const responseBytes = integer(source.responseBytes, 1, defaults.responseBytes);
  const sourceItems = integer(source.sourceItems, 1, defaults.sourceItems);
  const resultItems = integer(source.resultItems, 1, defaults.resultItems);
  const panelItems = integer(source.panelItems, 1, defaults.panelItems);
  const queryCharacters = integer(source.queryCharacters, 1, defaults.queryCharacters);
  const timeoutMs = integer(source.timeoutMs, 1_000, 60_000);
  return responseBytes === undefined ||
    sourceItems === undefined ||
    resultItems === undefined ||
    panelItems === undefined ||
    queryCharacters === undefined ||
    timeoutMs === undefined
    ? undefined
    : { responseBytes, sourceItems, resultItems, panelItems, queryCharacters, timeoutMs };
}

function malformedView(): PluginStarsPanelView {
  return {
    source: "",
    limit: defaults.limit,
    timeoutMs: defaults.timeoutMs,
    latest: null,
    inventory: { total: 0, shown: 0, truncated: false },
    limits: defaults,
    malformed: true,
  };
}

export function pluginStarsPanelView(data: unknown): PluginStarsPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !exact(source, rootKeys)) return malformedView();
  const sourceUrl = text(source.source, 2_048, false);
  const limit = integer(source.limit, 1, 50);
  const timeoutMs = integer(source.timeoutMs, 1_000, 60_000);
  const limits = limitsView(source.limits);
  const inventory = ownDataRecord(source.inventory, inventoryKeys);
  if (
    sourceUrl === undefined ||
    limit === undefined ||
    timeoutMs === undefined ||
    limits === undefined ||
    inventory === undefined ||
    !exact(inventory, inventoryKeys)
  )
    return malformedView();
  const total = integer(inventory.total, 0, limits.sourceItems);
  const shown = integer(inventory.shown, 0, limits.panelItems);
  if (total === undefined || shown === undefined || typeof inventory.truncated !== "boolean") return malformedView();
  const rawLatest = source.latest;
  let latest: PluginStarsPanelView["latest"] = null;
  if (rawLatest !== null) {
    const latestSource = ownDataRecord(rawLatest, latestKeys);
    if (latestSource === undefined || !exact(latestSource, latestKeys)) return malformedView();
    const latestName = text(latestSource.source, 256, false);
    const generatedAt = text(latestSource.generatedAt, 64, false);
    const query = text(latestSource.query, limits.queryCharacters);
    const fetchedAt = text(latestSource.fetchedAt, 64, false);
    const latestTotal = integer(latestSource.total, 0, limits.sourceItems);
    const rawResults = ownDataArray(latestSource.results, limits.panelItems);
    if (
      latestName === undefined ||
      generatedAt === undefined ||
      query === undefined ||
      fetchedAt === undefined ||
      latestTotal === undefined ||
      rawResults === undefined
    )
      return malformedView();
    const results: PluginStarsRowInput[] = [];
    for (const raw of rawResults) {
      const item = row(raw);
      if (item === undefined) return malformedView();
      results.push(item);
    }
    latest = { source: latestName, generatedAt, total: latestTotal, query, fetchedAt, results: pluginStarsRows(results, visibleRows) };
  }
  const visibleResults = latest?.results ?? [];
  if (
    shown !== visibleResults.length ||
    total < shown ||
    (latest === null && (total !== 0 || shown !== 0)) ||
    (latest !== null && latest.total < visibleResults.length)
  )
    return malformedView();
  return {
    source: sourceUrl,
    limit,
    timeoutMs,
    latest,
    inventory: { total, shown: visibleResults.length, truncated: inventory.truncated || total > visibleResults.length },
    limits,
    malformed: false,
  };
}
