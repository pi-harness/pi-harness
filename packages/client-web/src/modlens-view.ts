export type ModlensModeView = "native" | "evidence";

export interface ModlensImageView {
  readonly mode: ModlensModeView;
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly bytes: number;
  readonly cached: boolean;
  readonly at: string;
}

export type ModlensStatusView =
  | { readonly state: "idle" }
  | { readonly state: "running"; readonly mode: ModlensModeView; readonly path: string; readonly at: string }
  | ({ readonly state: "completed" } & ModlensImageView)
  | {
      readonly state: "failed" | "cancelled";
      readonly mode: ModlensModeView;
      readonly path: string;
      readonly at: string;
      readonly error: string;
    };

export interface ModlensPanelView {
  readonly attached: boolean;
  readonly image: ModlensImageView | null;
  readonly status: ModlensStatusView;
  readonly supportedTypes: readonly string[];
  readonly limits: {
    readonly imageBytes: number;
    readonly pathCharacters: number;
    readonly promptCharacters: number;
    readonly evidenceBytes: number;
    readonly agentTextBytes: number;
    readonly timeoutMs: number;
    readonly cacheEntries: number;
  };
  readonly truncated: boolean;
}

const supportedTypes = ["png", "jpeg", "jpg", "gif", "webp"] as const;
const supportedTypeSet = new Set<string>(supportedTypes);
const supportedMimeTypes = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxErrorCharacters = 2_000;
const defaults = {
  imageBytes: 10_485_760,
  pathCharacters: 4_096,
  promptCharacters: 4_000,
  evidenceBytes: 524_288,
  agentTextBytes: 131_072,
  timeoutMs: 180_000,
  cacheEntries: 64,
};
const minimumTimeoutMs = 1_000;
const maximumTimeoutMs = 300_000;

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

function cleanedText(value: unknown, maximum: number): { value: string | undefined; altered: boolean } {
  if (typeof value !== "string") return { value: undefined, altered: true };
  const sample = value.slice(0, maximum * 2 + 1);
  const cleaned = sample
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .slice(0, maximum);
  return { value: cleaned === "" ? undefined : cleaned, altered: cleaned !== value };
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new Date(value).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function imageMetadata(value: unknown, extraKeys: readonly string[] = []): { image: ModlensImageView | null; altered: boolean } {
  const source = ownDataRecord(value);
  if (source === undefined) return { image: null, altered: value !== null };
  const mode = source.mode === "native" || source.mode === "evidence" ? source.mode : undefined;
  const path = cleanedText(source.path, defaults.pathCharacters);
  const mimeType =
    typeof source.mimeType === "string" && supportedMimeTypes.has(source.mimeType) ? (source.mimeType as ModlensImageView["mimeType"]) : undefined;
  const bytes =
    typeof source.bytes === "number" && Number.isSafeInteger(source.bytes) && source.bytes >= 0 && source.bytes <= defaults.imageBytes
      ? source.bytes
      : undefined;
  const cached = typeof source.cached === "boolean" && !(mode === "native" && source.cached) ? source.cached : undefined;
  const at = canonicalTimestamp(source.at);
  const expectedKeys = new Set(["mode", "path", "mimeType", "bytes", "cached", "at", ...extraKeys]);
  const altered = path.altered || Object.keys(source).some((key) => !expectedKeys.has(key));
  if (mode === undefined || path.value === undefined || mimeType === undefined || bytes === undefined || cached === undefined || at === undefined)
    return { image: null, altered: true };
  return { image: { mode, path: path.value, mimeType, bytes, cached, at }, altered };
}

function statusView(value: unknown): { status: ModlensStatusView; altered: boolean } {
  const source = ownDataRecord(value);
  if (source === undefined) return { status: { state: "idle" }, altered: true };
  if (source.state === "idle") return { status: { state: "idle" }, altered: Object.keys(source).some((key) => key !== "state") };
  if (source.state === "completed") {
    const parsed = imageMetadata(source, ["state"]);
    return parsed.image === null ? { status: { state: "idle" }, altered: true } : { status: { state: "completed", ...parsed.image }, altered: parsed.altered };
  }
  if (source.state !== "running" && source.state !== "failed" && source.state !== "cancelled") return { status: { state: "idle" }, altered: true };
  const mode = source.mode === "native" || source.mode === "evidence" ? source.mode : undefined;
  const path = cleanedText(source.path, defaults.pathCharacters);
  const at = canonicalTimestamp(source.at);
  if (mode === undefined || path.value === undefined || at === undefined) return { status: { state: "idle" }, altered: true };
  if (source.state === "running") {
    const altered = path.altered || Object.keys(source).some((key) => !new Set(["state", "mode", "path", "at"]).has(key));
    return { status: { state: "running", mode, path: path.value, at }, altered };
  }
  const error = cleanedText(source.error, maxErrorCharacters);
  if (error.value === undefined) return { status: { state: "idle" }, altered: true };
  const altered = path.altered || error.altered || Object.keys(source).some((key) => !new Set(["state", "mode", "path", "at", "error"]).has(key));
  return { status: { state: source.state, mode, path: path.value, at, error: error.value }, altered };
}

function exactSupportedTypes(value: unknown): boolean {
  try {
    if (!Array.isArray(value)) return false;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || lengthDescriptor.value !== supportedTypes.length) return false;
    const seen = new Set<string>();
    for (let index = 0; index < supportedTypes.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string" || !supportedTypeSet.has(descriptor.value)) return false;
      seen.add(descriptor.value);
    }
    return seen.size === supportedTypes.length;
  } catch {
    return false;
  }
}

export function modlensPanelView(data: unknown): ModlensPanelView {
  const source = ownDataRecord(data);
  if (source === undefined) {
    return {
      attached: false,
      image: null,
      status: { state: "idle" },
      supportedTypes: [...supportedTypes],
      limits: { ...defaults },
      truncated: true,
    };
  }
  const parsedImage = imageMetadata(source.image);
  const parsedStatus = statusView(source.status);
  const completedStatusMatchesImage =
    parsedStatus.status.state !== "completed" ||
    (parsedImage.image !== null &&
      parsedStatus.status.mode === parsedImage.image.mode &&
      parsedStatus.status.path === parsedImage.image.path &&
      parsedStatus.status.mimeType === parsedImage.image.mimeType &&
      parsedStatus.status.bytes === parsedImage.image.bytes &&
      parsedStatus.status.cached === parsedImage.image.cached &&
      parsedStatus.status.at === parsedImage.image.at);
  const rawLimits = ownDataRecord(source.limits);
  const timeoutMs =
    rawLimits !== undefined &&
    typeof rawLimits.timeoutMs === "number" &&
    Number.isSafeInteger(rawLimits.timeoutMs) &&
    rawLimits.timeoutMs >= minimumTimeoutMs &&
    rawLimits.timeoutMs <= maximumTimeoutMs
      ? rawLimits.timeoutMs
      : defaults.timeoutMs;
  const fixedLimitKeys = ["imageBytes", "pathCharacters", "promptCharacters", "evidenceBytes", "agentTextBytes", "cacheEntries"] as const;
  const limitsAltered =
    rawLimits === undefined ||
    fixedLimitKeys.some((key) => rawLimits[key] !== defaults[key]) ||
    Object.keys(rawLimits).some((key) => ![...fixedLimitKeys, "timeoutMs"].includes(key)) ||
    timeoutMs !== rawLimits.timeoutMs;
  const attached = parsedImage.image !== null;
  const expectedRootKeys = new Set(["attached", "image", "status", "supportedTypes", "limits"]);
  const truncated =
    parsedImage.altered ||
    parsedStatus.altered ||
    !completedStatusMatchesImage ||
    limitsAltered ||
    !exactSupportedTypes(source.supportedTypes) ||
    source.attached !== attached ||
    Object.keys(source).some((key) => !expectedRootKeys.has(key));
  return {
    attached,
    image: parsedImage.image,
    status: parsedStatus.status,
    supportedTypes: [...supportedTypes],
    limits: { ...defaults, timeoutMs },
    truncated,
  };
}
