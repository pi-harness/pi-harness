export type I18nPairStatusState = "idle" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface I18nPairPanelView {
  readonly status: { readonly state: I18nPairStatusState; readonly at: string | null; readonly error: string | null };
  readonly report: {
    readonly base: string;
    readonly target: string;
    readonly baseKeys: number;
    readonly targetKeys: number;
    readonly missing: readonly string[];
    readonly extra: readonly string[];
    readonly missingTotal: number;
    readonly extraTotal: number;
    readonly truncated: boolean;
  } | null;
  readonly malformed: boolean;
  readonly limits: typeof defaults;
}

const visibleKeysPerSide = 50;
const maxStatusErrorCharacters = 2_000;
const visibleStatusErrorCharacters = 500;
const defaults = {
  fileBytes: 4_194_304,
  depth: 128,
  keysPerFile: 50_000,
  flattenedKeyLength: 2_048,
  pathLength: 4_096,
  panelKeysPerSide: 100,
} as const;
const rootKeys = new Set(["status", "report", "limits"]);
const statusKeys = new Set(["state", "at", "error"]);
const reportKeys = new Set(["base", "target", "baseKeys", "targetKeys", "missing", "extra", "missingTotal", "extraTotal", "truncated"]);
const limitKeys = new Set(Object.keys(defaults));
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}]/u;

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

function hasExactly(source: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const own = Object.keys(source);
  return own.length === keys.size && own.every((key) => keys.has(key));
}

function safeInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function safeText(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value !== value.trim() || unsafeUnicode.test(value)) return undefined;
  if ([...value].length > maximum || new TextEncoder().encode(value).byteLength > maximum) return undefined;
  return value;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > defaults.panelKeysPerSide) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key))) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return undefined;
    const output: string[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      const item: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      const text = safeText(item, defaults.flattenedKeyLength, true);
      if (text === undefined) return undefined;
      output.push(text);
    }
    return output;
  } catch {
    return undefined;
  }
}

function statusView(value: unknown): I18nPairPanelView["status"] | undefined {
  const source = ownDataRecord(value, statusKeys);
  if (source === undefined) return undefined;
  if (source.state === "idle" && hasExactly(source, new Set(["state"]))) return { state: "idle", at: null, error: null };
  if (source.state === "running" && hasExactly(source, new Set(["state"]))) return { state: "running", at: null, error: null };
  const at = timestamp(source.at);
  if (source.state === "completed" && at !== undefined && hasExactly(source, new Set(["state", "at"]))) return { state: "completed", at, error: null };
  if ((source.state === "failed" || source.state === "cancelled") && at !== undefined && hasExactly(source, statusKeys)) {
    const error = safeText(source.error, maxStatusErrorCharacters);
    if (error !== undefined) return { state: source.state, at, error: [...error].slice(0, visibleStatusErrorCharacters).join("") };
  }
  return undefined;
}

function reportView(value: unknown): I18nPairPanelView["report"] | undefined {
  const source = ownDataRecord(value, reportKeys);
  if (source === undefined || !hasExactly(source, reportKeys)) return undefined;
  const base = safeText(source.base, defaults.pathLength);
  const target = safeText(source.target, defaults.pathLength);
  const baseKeys = safeInteger(source.baseKeys, defaults.keysPerFile);
  const targetKeys = safeInteger(source.targetKeys, defaults.keysPerFile);
  const missing = stringArray(source.missing);
  const extra = stringArray(source.extra);
  const missingTotal = safeInteger(source.missingTotal, defaults.keysPerFile);
  const extraTotal = safeInteger(source.extraTotal, defaults.keysPerFile);
  if (
    base === undefined ||
    target === undefined ||
    baseKeys === undefined ||
    targetKeys === undefined ||
    missing === undefined ||
    extra === undefined ||
    missingTotal === undefined ||
    extraTotal === undefined ||
    typeof source.truncated !== "boolean"
  )
    return undefined;
  const expectedMissingLength = Math.min(missingTotal, defaults.panelKeysPerSide);
  const expectedExtraLength = Math.min(extraTotal, defaults.panelKeysPerSide);
  const expectedTruncated = expectedMissingLength < missingTotal || expectedExtraLength < extraTotal;
  if (
    missing.length !== expectedMissingLength ||
    extra.length !== expectedExtraLength ||
    source.truncated !== expectedTruncated ||
    missingTotal > baseKeys ||
    extraTotal > targetKeys ||
    baseKeys - missingTotal !== targetKeys - extraTotal ||
    new Set(missing).size !== missing.length ||
    new Set(extra).size !== extra.length ||
    missing.some((key) => extra.includes(key))
  )
    return undefined;
  return {
    base,
    target,
    baseKeys,
    targetKeys,
    missing: missing.slice(0, visibleKeysPerSide),
    extra: extra.slice(0, visibleKeysPerSide),
    missingTotal,
    extraTotal,
    truncated: expectedTruncated || missing.length > visibleKeysPerSide || extra.length > visibleKeysPerSide,
  };
}

function validLimits(value: unknown): boolean {
  const source = ownDataRecord(value, limitKeys);
  return source !== undefined && hasExactly(source, limitKeys) && Object.entries(defaults).every(([key, expected]) => source[key] === expected);
}

function malformedView(): I18nPairPanelView {
  return {
    status: { state: "unknown", at: null, error: null },
    report: null,
    malformed: true,
    limits: { ...defaults },
  };
}

export function i18nPairPanelView(data: unknown): I18nPairPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !hasExactly(source, rootKeys) || !validLimits(source.limits)) return malformedView();
  const status = statusView(source.status);
  if (status === undefined) return malformedView();
  const report = source.report === null ? null : reportView(source.report);
  if (report === undefined || (status.state === "idle" && report !== null) || (status.state === "completed" && report === null)) return malformedView();
  return { status, report, malformed: false, limits: { ...defaults } };
}
