const visibleTabs = 8;
const maximumTabInventory = 256;
const defaults = {
  tabs: 20,
  textPreviewCharacters: 12_000,
  errorCharacters: 2_000,
} as const;
const rootKeys = new Set(["endpoint", "connected", "error", "tabs", "inventory", "limits", "latest"]);
const tabKeys = new Set(["targetId", "title", "url"]);
const inventoryKeys = new Set(["total", "shown", "truncated"]);
const limitsKeys = new Set(["tabs", "textPreviewCharacters", "errorCharacters"]);
const latestKeys = new Set(["targetId", "title", "url", "status", "truncated", "previewTruncated", "text", "clicked", "screenshot"]);
const screenshotKeys = new Set(["bytes", "mimeType"]);
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

export interface BrowserSessionTab {
  readonly targetId: string;
  readonly title: string;
  readonly url: string;
}

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

function safeText(value: unknown, maximum: number, allowEmpty = true): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || unsafeUnicode.test(value)) return undefined;
  if ([...value].length > maximum || new TextEncoder().encode(value).byteLength > maximum) return undefined;
  return value;
}

// Tab titles and page text come straight from the browser, which legitimately produces line breaks and format code points such as the zero width joiner inside emoji; those fields are display-only, so unsafe code points are replaced rather than failing the whole panel.
function sanitizedText(value: unknown, maximum: number, allowLineBreaks = false): string | undefined {
  if (typeof value !== "string") return undefined;
  if ([...value].length > maximum || new TextEncoder().encode(value).byteLength > maximum) return undefined;
  let output = "";
  for (const character of value)
    output += (allowLineBreaks && (character === "\t" || character === "\n" || character === "\r")) || !unsafeUnicode.test(character) ? character : "�";
  return output;
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function display(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function tabView(value: unknown): BrowserSessionTab | undefined {
  const source = ownDataRecord(value, tabKeys);
  if (source === undefined || !exact(source, tabKeys)) return undefined;
  const targetId = safeText(source.targetId, 512, false);
  const title = sanitizedText(source.title, 4_096);
  const url = safeText(source.url, 8_192);
  return targetId === undefined || title === undefined || url === undefined ? undefined : { targetId, title, url };
}

export function browserSessionTabs(entries: readonly BrowserSessionTab[], limit: number): readonly BrowserSessionTab[] {
  const normalizedLimit = Math.max(0, Math.min(20, Math.trunc(limit)));
  return entries
    .slice(0, 32)
    .map(tabView)
    .filter((entry): entry is BrowserSessionTab => entry !== undefined)
    .slice(0, normalizedLimit);
}

function screenshotView(value: unknown): { bytes: number; mimeType: string } | undefined {
  const source = ownDataRecord(value, screenshotKeys);
  if (source === undefined || !exact(source, screenshotKeys) || source.mimeType !== "image/png") return undefined;
  const bytes = integer(source.bytes, 0, 8 * 1024 * 1024);
  return bytes === undefined ? undefined : { bytes, mimeType: "image/png" };
}

function limitsView(value: unknown): BrowserSessionPanelView["limits"] | undefined {
  const source = ownDataRecord(value, limitsKeys);
  if (source === undefined || !exact(source, limitsKeys)) return undefined;
  const tabs = integer(source.tabs, 1, defaults.tabs);
  const textPreviewCharacters = integer(source.textPreviewCharacters, 1, defaults.textPreviewCharacters);
  const errorCharacters = integer(source.errorCharacters, 1, defaults.errorCharacters);
  return tabs === undefined || textPreviewCharacters === undefined || errorCharacters === undefined
    ? undefined
    : { tabs, textPreviewCharacters, errorCharacters };
}

function latestView(value: unknown, limits: BrowserSessionPanelView["limits"]): BrowserSessionPanelView["latest"] | undefined {
  if (value === null) return null;
  const source = ownDataRecord(value, latestKeys);
  if (source === undefined || ![...Object.keys(source)].every((key) => latestKeys.has(key))) return undefined;
  const targetId = safeText(source.targetId, 512, false);
  const title = sanitizedText(source.title, 4_096);
  const url = safeText(source.url, 8_192);
  if (targetId === undefined || title === undefined || url === undefined) return undefined;
  if (source.status !== undefined && safeText(source.status, 64, false) === undefined) return undefined;
  if (source.truncated !== undefined && typeof source.truncated !== "boolean") return undefined;
  if (source.previewTruncated !== undefined && typeof source.previewTruncated !== "boolean") return undefined;
  if (source.clicked !== undefined && typeof source.clicked !== "boolean") return undefined;
  const rawText = source.text === undefined ? undefined : sanitizedText(source.text, 128 * 1024, true);
  if (source.text !== undefined && rawText === undefined) return undefined;
  const screenshot = source.screenshot === undefined ? undefined : screenshotView(source.screenshot);
  if (source.screenshot !== undefined && screenshot === undefined) return undefined;
  const text = rawText === undefined ? undefined : display(rawText, limits.textPreviewCharacters);
  return {
    targetId,
    title: display(title, 4_096),
    url: display(url, 8_192),
    ...(source.status === undefined ? {} : { status: display(source.status as string, 64) }),
    truncated: source.truncated === true,
    previewTruncated: source.previewTruncated === true || (rawText !== undefined && rawText.length > limits.textPreviewCharacters),
    ...(text === undefined ? {} : { text }),
    clicked: source.clicked === true,
    ...(screenshot === undefined ? {} : { screenshot }),
  };
}

export interface BrowserSessionPanelView {
  readonly endpoint: string;
  readonly connected: boolean;
  readonly error: string | null;
  readonly tabs: readonly BrowserSessionTab[];
  readonly inventory: { readonly total: number; readonly shown: number; readonly truncated: boolean };
  readonly limits: { readonly tabs: number; readonly textPreviewCharacters: number; readonly errorCharacters: number };
  readonly latest: {
    readonly targetId: string;
    readonly title: string;
    readonly url: string;
    readonly status?: string;
    readonly truncated: boolean;
    readonly previewTruncated: boolean;
    readonly text?: string;
    readonly clicked: boolean;
    readonly screenshot?: { readonly bytes: number; readonly mimeType: string };
  } | null;
  readonly malformed: boolean;
}

function malformedView(): BrowserSessionPanelView {
  return {
    endpoint: "",
    connected: false,
    error: "Panel data unavailable",
    tabs: [],
    inventory: { total: 0, shown: 0, truncated: false },
    limits: defaults,
    latest: null,
    malformed: true,
  };
}

export function browserSessionPanelView(data: unknown): BrowserSessionPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !exact(source, rootKeys) || typeof source.connected !== "boolean") return malformedView();
  const endpoint = safeText(source.endpoint, 2_048, false);
  const error = source.error === null ? null : safeText(source.error, defaults.errorCharacters, true);
  const limits = limitsView(source.limits);
  const rawTabs = ownDataArray(source.tabs, maximumTabInventory);
  const inventory = ownDataRecord(source.inventory, inventoryKeys);
  if (
    endpoint === undefined ||
    error === undefined ||
    limits === undefined ||
    rawTabs === undefined ||
    inventory === undefined ||
    !exact(inventory, inventoryKeys)
  )
    return malformedView();
  const tabs: BrowserSessionTab[] = [];
  for (const raw of rawTabs) {
    const tab = tabView(raw);
    if (tab === undefined) return malformedView();
    tabs.push(tab);
  }
  const total = integer(inventory.total, tabs.length, maximumTabInventory);
  const shown = integer(inventory.shown, 0, limits.tabs);
  if (
    total === undefined ||
    shown === undefined ||
    shown !== tabs.length ||
    tabs.length > limits.tabs ||
    typeof inventory.truncated !== "boolean" ||
    total < shown
  )
    return malformedView();
  const latest = latestView(source.latest, limits);
  if (latest === undefined) return malformedView();
  const visible = tabs.slice(0, visibleTabs);
  return {
    endpoint,
    connected: source.connected,
    error,
    tabs: visible,
    inventory: { total, shown: visible.length, truncated: inventory.truncated || total > shown || tabs.length > visible.length },
    limits,
    latest,
    malformed: false,
  };
}
