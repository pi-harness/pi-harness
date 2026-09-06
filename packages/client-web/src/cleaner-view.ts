export type CleanerActivityStatus = "running" | "completed" | "failed" | "cancelled";

export interface CleanerPanelView {
  readonly capsules: ReadonlyArray<{ readonly name: string; readonly bytes: number }>;
  readonly totalBytes: number | null;
  readonly inventory: { readonly total: number; readonly shown: number; readonly truncated: boolean; readonly displayLimit: number } | null;
  readonly lastCleanup: {
    readonly status: CleanerActivityStatus;
    readonly at: string;
    readonly requestedKeep: number;
    readonly removed: number;
    readonly kept: number | null;
    readonly error: string | null;
  } | null;
  readonly malformed: boolean;
  readonly limits: { readonly capsules: 256; readonly directoryEntries: 4_096 };
}

const visibleCapsules = 12;
const maxCapsuleNameLength = 255;
const maxActivityErrorLength = 2_000;
const visibleActivityErrorLength = 500;
const defaults = { capsules: 256, directoryEntries: 4_096, displayLimit: 20 } as const;
const rootKeys = new Set(["capsules", "inventory", "lastCleanup", "lastRemoved", "limits"]);
const capsuleKeys = new Set(["name", "bytes"]);
const inventoryKeys = new Set(["total", "shown", "truncated", "displayLimit"]);
const activityKeys = new Set(["status", "at", "requestedKeep", "removed", "kept", "error"]);
const limitKeys = new Set(["capsules", "directoryEntries"]);
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

function hasExactly(source: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const own = Object.keys(source);
  return own.length === keys.size && own.every((key) => keys.has(key));
}

function safeInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function safeText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || unsafeUnicode.test(value)) return undefined;
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

function capsuleName(value: unknown): string | undefined {
  const name = safeText(value, maxCapsuleNameLength);
  return name?.endsWith(".patch") === true && !name.includes("/") && !name.includes("\\") ? name : undefined;
}

function capsule(value: unknown): { name: string; bytes: number } | undefined {
  const source = ownDataRecord(value, capsuleKeys);
  if (source === undefined || !hasExactly(source, capsuleKeys)) return undefined;
  const name = capsuleName(source.name);
  const bytes = safeInteger(source.bytes, Number.MAX_SAFE_INTEGER);
  return name === undefined || bytes === undefined ? undefined : { name, bytes };
}

function capsuleArray(value: unknown): Array<{ name: string; bytes: number }> | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > defaults.displayLimit) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= (length as number) || String(Number(key)) !== key),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return undefined;
    const output: Array<{ name: string; bytes: number }> = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      const item = capsule(descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined);
      if (item === undefined) return undefined;
      output.push(item);
    }
    if (new Set(output.map((item) => item.name)).size !== output.length) return undefined;
    return output;
  } catch {
    return undefined;
  }
}

function inventoryView(value: unknown, capsuleCount: number): { total: number; shown: number; truncated: boolean; displayLimit: number } | undefined {
  const source = ownDataRecord(value, inventoryKeys);
  if (source === undefined || !hasExactly(source, inventoryKeys)) return undefined;
  const total = safeInteger(source.total, defaults.capsules);
  const shown = safeInteger(source.shown, defaults.displayLimit);
  if (
    total === undefined ||
    shown === undefined ||
    shown !== capsuleCount ||
    shown > total ||
    source.displayLimit !== defaults.displayLimit ||
    typeof source.truncated !== "boolean" ||
    source.truncated !== total > shown
  )
    return undefined;
  return { total, shown, truncated: source.truncated, displayLimit: defaults.displayLimit };
}

function activityView(value: unknown): CleanerPanelView["lastCleanup"] | undefined {
  const source = ownDataRecord(value, activityKeys);
  if (source === undefined) return undefined;
  const status = source.status;
  const at = timestamp(source.at);
  const requestedKeep = safeInteger(source.requestedKeep, defaults.capsules);
  const removed = safeInteger(source.removed, defaults.capsules);
  if (
    (status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled") ||
    at === undefined ||
    requestedKeep === undefined ||
    removed === undefined
  )
    return undefined;
  const baseKeys = new Set(["status", "at", "requestedKeep", "removed"]);
  if (status === "running" && hasExactly(source, baseKeys)) return { status, at, requestedKeep, removed, kept: null, error: null };
  if (status === "completed" && hasExactly(source, new Set([...baseKeys, "kept"]))) {
    const kept = safeInteger(source.kept, defaults.capsules);
    return kept === undefined ? undefined : { status, at, requestedKeep, removed, kept, error: null };
  }
  if ((status === "failed" || status === "cancelled") && hasExactly(source, new Set([...baseKeys, "error"]))) {
    const error = safeText(source.error, maxActivityErrorLength);
    return error === undefined
      ? undefined
      : { status, at, requestedKeep, removed, kept: null, error: [...error].slice(0, visibleActivityErrorLength).join("") };
  }
  return undefined;
}

function validLimits(value: unknown): boolean {
  const source = ownDataRecord(value, limitKeys);
  return (
    source !== undefined && hasExactly(source, limitKeys) && source.capsules === defaults.capsules && source.directoryEntries === defaults.directoryEntries
  );
}

function malformedView(): CleanerPanelView {
  return {
    capsules: [],
    totalBytes: null,
    inventory: null,
    lastCleanup: null,
    malformed: true,
    limits: { capsules: defaults.capsules, directoryEntries: defaults.directoryEntries },
  };
}

export function cleanerPanelView(data: unknown): CleanerPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !hasExactly(source, rootKeys) || !validLimits(source.limits)) return malformedView();
  const capsules = capsuleArray(source.capsules);
  if (capsules === undefined) return malformedView();
  const inventory = inventoryView(source.inventory, capsules.length);
  const lastRemoved = safeInteger(source.lastRemoved, defaults.capsules);
  if (inventory === undefined || lastRemoved === undefined) return malformedView();
  const lastCleanup = source.lastCleanup === null ? null : activityView(source.lastCleanup);
  if (lastCleanup === undefined || (lastCleanup === null ? lastRemoved !== 0 : lastCleanup.removed !== lastRemoved)) return malformedView();
  const visible = capsules.slice(0, visibleCapsules);
  const totalBytes = visible.reduce((sum, item) => sum + item.bytes, 0);
  if (!Number.isSafeInteger(totalBytes)) return malformedView();
  return {
    capsules: visible,
    totalBytes,
    inventory: {
      total: inventory.total,
      shown: visible.length,
      truncated: inventory.truncated || capsules.length > visible.length,
      displayLimit: inventory.displayLimit,
    },
    lastCleanup,
    malformed: false,
    limits: { capsules: defaults.capsules, directoryEntries: defaults.directoryEntries },
  };
}
