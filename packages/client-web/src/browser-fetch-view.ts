export interface BrowserFetchPanelView {
  readonly latest: {
    readonly url: string;
    readonly finalUrl: string;
    readonly status: number;
    readonly contentType: string;
    readonly bytes: number;
    readonly truncated: boolean;
    readonly previewTruncated: boolean;
    readonly text: string;
  } | null;
  readonly allowPrivate: boolean;
  readonly limits: { readonly responseBytes: number; readonly panelTextChars: number; readonly redirects: number; readonly timeoutMs: number };
  readonly malformed: boolean;
}

const defaults = {
  responseBytes: 512 * 1024,
  panelTextChars: 12_000,
  redirects: 3,
  timeoutMs: 20_000,
} as const;
const rootKeys = new Set(["latest", "allowPrivate", "maxResponseBytes", "maxPanelTextChars", "maxRedirects", "timeoutMs"]);
const latestKeys = new Set(["url", "finalUrl", "status", "contentType", "bytes", "truncated", "previewTruncated", "text"]);
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

function boundedText(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || unsafeUnicode.test(value)) return undefined;
  if ([...value].length > maximum || new TextEncoder().encode(value).byteLength > maximum) return undefined;
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function limitsView(source: Record<string, unknown>): BrowserFetchPanelView["limits"] | undefined {
  const responseBytes = integer(source.maxResponseBytes, 1, defaults.responseBytes);
  const panelTextChars = integer(source.maxPanelTextChars, 1, defaults.panelTextChars);
  const redirects = integer(source.maxRedirects, 0, 10);
  const timeoutMs = integer(source.timeoutMs, 100, 60_000);
  if (responseBytes === undefined || panelTextChars === undefined || redirects === undefined || timeoutMs === undefined) return undefined;
  return { responseBytes, panelTextChars, redirects, timeoutMs };
}

function latestView(value: unknown, limits: BrowserFetchPanelView["limits"]): BrowserFetchPanelView["latest"] | undefined {
  if (value === null) return null;
  const source = ownDataRecord(value, latestKeys);
  if (source === undefined || !exact(source, latestKeys)) return undefined;
  const url = boundedText(source.url, 4_096);
  const finalUrl = boundedText(source.finalUrl, 4_096);
  const contentType = boundedText(source.contentType, 256);
  const text = boundedText(source.text, defaults.responseBytes, true);
  const status = integer(source.status, 100, 599);
  const bytes = integer(source.bytes, 0, limits.responseBytes);
  if (
    url === undefined ||
    finalUrl === undefined ||
    contentType === undefined ||
    text === undefined ||
    status === undefined ||
    bytes === undefined ||
    typeof source.truncated !== "boolean" ||
    typeof source.previewTruncated !== "boolean"
  )
    return undefined;
  const displayed = [...text].slice(0, limits.panelTextChars).join("");
  return {
    url,
    finalUrl,
    status,
    contentType,
    bytes,
    truncated: source.truncated,
    previewTruncated: source.previewTruncated || text.length > limits.panelTextChars,
    text: displayed,
  };
}

function malformedView(): BrowserFetchPanelView {
  return { latest: null, allowPrivate: false, limits: { ...defaults }, malformed: true };
}

export function browserFetchPanelView(data: unknown): BrowserFetchPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !exact(source, rootKeys) || typeof source.allowPrivate !== "boolean") return malformedView();
  const limits = limitsView(source);
  if (limits === undefined) return malformedView();
  const latest = latestView(source.latest, limits);
  return latest === undefined ? malformedView() : { latest, allowPrivate: source.allowPrivate, limits, malformed: false };
}
