export interface GitTimeCapsuleActivityView {
  readonly action: "capture" | "restore";
  readonly status: "completed" | "failed" | "cancelled";
  readonly at: string;
  readonly name: string | null;
  readonly bytes: number;
  readonly files: number;
  readonly error: string | null;
}

export interface GitTimeCapsulePanelView {
  readonly latest: GitTimeCapsuleActivityView | null;
  readonly capsules: readonly { readonly name: string; readonly bytes: number }[];
  readonly inventory: { readonly total: number; readonly shown: number; readonly truncated: boolean; readonly displayLimit: number };
  readonly timeoutMs: number;
  readonly limits: { readonly capsuleBytes: number; readonly inventory: number; readonly directoryEntries: number };
  readonly truncated: boolean;
}

const defaults = {
  timeoutMs: 15_000,
  capsuleBytes: 8 * 1024 * 1024,
  inventory: 256,
  directoryEntries: 4_096,
  displayLimit: 20,
};
const maxErrorLength = 2_000;

function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return undefined;
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

function ownDataArray(value: unknown, maximum: number): { values: unknown[]; altered: boolean } | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return undefined;
    const count = Math.min(length.value as number, maximum);
    const values: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      values.push(descriptor.value);
    }
    return { values, altered: length.value > maximum };
  } catch {
    return undefined;
  }
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function boundedCount(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function expectedKeys(source: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(source).every((key) => expected.has(key));
}

function capsuleName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value.length === 0 ||
    value.length > 255 ||
    value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > 255 ||
    !value.endsWith(".patch") ||
    /[/\\\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  )
    return undefined;
  return value;
}

function cleanedError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const error = value
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .slice(0, maxErrorLength);
  return error === "" ? null : error;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new Date(value).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function activity(value: unknown): GitTimeCapsuleActivityView | null {
  const source = ownDataRecord(value);
  if (source === undefined || (source.action !== "capture" && source.action !== "restore")) return null;
  if (source.status !== "completed" && source.status !== "failed" && source.status !== "cancelled") return null;
  const at = canonicalTimestamp(source.at);
  if (at === undefined) return null;
  const name = source.name === undefined ? null : capsuleName(source.name);
  if (source.name !== undefined && name === undefined) return null;
  if (source.status === "completed" && name === null) return null;
  const error = cleanedError(source.error);
  const bytes = boundedCount(source.bytes, defaults.capsuleBytes);
  const files = boundedCount(source.files, defaults.capsuleBytes);
  if (source.status === "completed" && (bytes === undefined || bytes === 0 || files === undefined || files === 0)) return null;
  if (source.action === "restore" && source.status === "completed" && source.restored !== true) return null;
  if ((source.status === "failed" || source.status === "cancelled") && error === null) return null;
  if (source.status === "completed" && error !== null) return null;
  return {
    action: source.action,
    status: source.status,
    at,
    name: name ?? null,
    bytes: bytes ?? 0,
    files: files ?? 0,
    error,
  };
}

function activityContractValid(source: Record<string, unknown>): boolean {
  if (source.status === "completed")
    return expectedKeys(source, ["action", "status", "at", "name", "bytes", "files", ...(source.action === "restore" ? ["restored"] : [])]);
  return expectedKeys(source, ["action", "status", "at", "error"]);
}

function capsule(value: unknown): { name: string; bytes: number } | undefined {
  const source = ownDataRecord(value);
  if (source === undefined) return undefined;
  const name = capsuleName(source.name);
  const bytes = boundedCount(source.bytes, defaults.capsuleBytes);
  if (name === undefined || bytes === undefined || bytes === 0) return undefined;
  return { name, bytes };
}

export function gitTimeCapsulePanelView(data: unknown): GitTimeCapsulePanelView {
  const parsedSource = ownDataRecord(data);
  const source = parsedSource ?? {};
  const rawCapsules = ownDataArray(source.capsules, defaults.displayLimit);
  const visible = rawCapsules?.values ?? [];
  const parsedCapsules = visible.map((value) => {
    const record = ownDataRecord(value);
    return { value: capsule(value), contractValid: record !== undefined && expectedKeys(record, ["name", "bytes"]) };
  });
  const capsules = parsedCapsules.map((item) => item.value).filter((item): item is { name: string; bytes: number } => item !== undefined);
  const rawInventory = ownDataRecord(source.inventory) ?? {};
  const rawLimits = ownDataRecord(source.limits) ?? {};
  const rawLatest = ownDataRecord(source.latest);
  const latest = activity(source.latest);
  const total = count(rawInventory.total, capsules.length);
  const shown = count(rawInventory.shown, capsules.length);
  const inventoryValid =
    total >= capsules.length &&
    total <= defaults.inventory &&
    shown === capsules.length &&
    rawInventory.truncated !== undefined &&
    typeof rawInventory.truncated === "boolean" &&
    rawInventory.displayLimit === defaults.displayLimit &&
    expectedKeys(rawInventory, ["total", "shown", "truncated", "displayLimit"]);
  const limitsValid =
    rawLimits.capsuleBytes === defaults.capsuleBytes &&
    rawLimits.inventory === defaults.inventory &&
    rawLimits.directoryEntries === defaults.directoryEntries &&
    expectedKeys(rawLimits, ["capsuleBytes", "inventory", "directoryEntries"]);
  const parsedTimeout =
    typeof source.timeoutMs === "number" && Number.isSafeInteger(source.timeoutMs) && source.timeoutMs >= 100 && source.timeoutMs <= 60_000
      ? source.timeoutMs
      : undefined;
  const timeoutValid = parsedTimeout !== undefined;
  const dataWasTruncated =
    parsedSource === undefined ||
    rawCapsules === undefined ||
    rawCapsules.altered ||
    parsedCapsules.some((item) => !item.contractValid) ||
    capsules.length !== visible.length ||
    (source.latest !== null && (rawLatest === undefined || latest === null || !activityContractValid(rawLatest))) ||
    (typeof rawLatest?.error === "string" ? rawLatest.error !== latest?.error : false) ||
    !inventoryValid ||
    !limitsValid ||
    !timeoutValid ||
    !expectedKeys(source, ["latest", "capsules", "inventory", "timeoutMs", "limits"]);
  return {
    latest,
    capsules,
    inventory: {
      total: inventoryValid ? total : Math.max(capsules.length, Math.min(defaults.inventory, total)),
      shown: capsules.length,
      truncated: rawInventory.truncated === true || dataWasTruncated,
      displayLimit: defaults.displayLimit,
    },
    timeoutMs: parsedTimeout ?? defaults.timeoutMs,
    limits: {
      capsuleBytes: defaults.capsuleBytes,
      inventory: defaults.inventory,
      directoryEntries: defaults.directoryEntries,
    },
    truncated: dataWasTruncated,
  };
}
