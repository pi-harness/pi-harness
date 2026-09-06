export type VisionToolkitOperationView = "catalog" | "info";

export interface VisionToolkitAssetView {
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly headerTruncated: boolean;
}

export interface VisionToolkitIssueView {
  readonly path: string;
  readonly reason: string;
}

export interface VisionToolkitReportView {
  readonly assets: readonly VisionToolkitAssetView[];
  readonly issues: readonly VisionToolkitIssueView[];
  readonly inspectedCandidates: number;
  readonly scannedEntries: number;
  readonly scannedDirectories: number;
  readonly truncated: boolean;
  readonly issuesTruncated: boolean;
}

export type VisionToolkitStatusView =
  | { readonly state: "idle" }
  | { readonly state: "running"; readonly operation: VisionToolkitOperationView; readonly path?: string; readonly at: string }
  | {
      readonly state: "completed";
      readonly operation: VisionToolkitOperationView;
      readonly path?: string;
      readonly count: number;
      readonly truncated: boolean;
      readonly at: string;
    }
  | {
      readonly state: "failed" | "cancelled";
      readonly operation: VisionToolkitOperationView;
      readonly path?: string;
      readonly error: string;
      readonly at: string;
    };

export interface VisionToolkitPanelView {
  readonly status: VisionToolkitStatusView;
  readonly report: VisionToolkitReportView | null;
  readonly supportedTypes: readonly string[];
  readonly limits: typeof defaultLimits;
  readonly truncated: boolean;
}

const supportedTypes = ["png", "jpeg", "jpg", "gif", "webp"] as const;
const supportedTypeSet = new Set<string>(supportedTypes);
const supportedMimeTypes = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const defaultLimits = {
  imageBytes: 20_971_520,
  headerBytes: 262_144,
  pathCharacters: 4_096,
  assets: 100,
  imageCandidates: 256,
  scannedEntries: 4_096,
  scannedDirectories: 512,
  depth: 16,
  issues: 20,
  issueCharacters: 500,
  agentTextBytes: 16_384,
} as const;

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

function cleanedText(value: unknown, maximum: number): { value: string | undefined; altered: boolean } {
  if (typeof value !== "string") return { value: undefined, altered: true };
  const sample = value.slice(0, maximum * 2 + 1);
  const cleaned = sample
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .slice(0, maximum);
  return { value: cleaned === "" ? undefined : cleaned, altered: cleaned !== value };
}

function integer(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new Date(value).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function expectedKeys(source: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(source).every((key) => expected.has(key));
}

function assetView(value: unknown): { asset: VisionToolkitAssetView | undefined; altered: boolean } {
  const source = ownDataRecord(value);
  if (source === undefined) return { asset: undefined, altered: true };
  const path = cleanedText(source.path, defaultLimits.pathCharacters);
  const mimeType =
    typeof source.mimeType === "string" && supportedMimeTypes.has(source.mimeType) ? (source.mimeType as VisionToolkitAssetView["mimeType"]) : undefined;
  const bytes = integer(source.bytes, defaultLimits.imageBytes);
  const maximumDimension = mimeType === "image/png" ? 0x7fffffff : mimeType === "image/webp" ? 0x1000000 : 0xffff;
  const width = source.width === null ? null : integer(source.width, maximumDimension);
  const height = source.height === null ? null : integer(source.height, maximumDimension);
  const headerTruncated = typeof source.headerTruncated === "boolean" ? source.headerTruncated : undefined;
  const dimensionsValid =
    (typeof width === "number" && width > 0 && typeof height === "number" && height > 0) ||
    (width === null && height === null && headerTruncated === true && mimeType === "image/jpeg");
  const altered = path.altered || !expectedKeys(source, ["path", "mimeType", "bytes", "width", "height", "headerTruncated"]);
  if (path.value === undefined || mimeType === undefined || bytes === undefined || headerTruncated === undefined || !dimensionsValid)
    return { asset: undefined, altered: true };
  return { asset: { path: path.value, mimeType, bytes, width: width!, height: height!, headerTruncated }, altered };
}

function issueView(value: unknown): { issue: VisionToolkitIssueView | undefined; altered: boolean } {
  const source = ownDataRecord(value);
  if (source === undefined) return { issue: undefined, altered: true };
  const path = cleanedText(source.path, defaultLimits.pathCharacters);
  const reason = cleanedText(source.reason, defaultLimits.issueCharacters);
  const altered = path.altered || reason.altered || !expectedKeys(source, ["path", "reason"]);
  if (path.value === undefined || reason.value === undefined) return { issue: undefined, altered: true };
  return { issue: { path: path.value, reason: reason.value }, altered };
}

function reportView(value: unknown): { report: VisionToolkitReportView | null; altered: boolean } {
  if (value === null) return { report: null, altered: false };
  const source = ownDataRecord(value);
  if (source === undefined) return { report: null, altered: true };
  const rawAssets = ownDataArray(source.assets, defaultLimits.assets);
  const rawIssues = ownDataArray(source.issues, defaultLimits.issues);
  if (rawAssets === undefined || rawIssues === undefined) return { report: null, altered: true };
  const assets: VisionToolkitAssetView[] = [];
  const issues: VisionToolkitIssueView[] = [];
  let altered = rawAssets.altered || rawIssues.altered;
  for (const value of rawAssets.values) {
    const parsed = assetView(value);
    altered ||= parsed.altered;
    if (parsed.asset !== undefined) assets.push(parsed.asset);
  }
  for (const value of rawIssues.values) {
    const parsed = issueView(value);
    altered ||= parsed.altered;
    if (parsed.issue !== undefined) issues.push(parsed.issue);
  }
  const inspectedCandidates = integer(source.inspectedCandidates, defaultLimits.imageCandidates);
  const scannedEntries = integer(source.scannedEntries, defaultLimits.scannedEntries);
  const scannedDirectories = integer(source.scannedDirectories, defaultLimits.scannedDirectories);
  const truncated = typeof source.truncated === "boolean" ? source.truncated : undefined;
  const issuesTruncated = typeof source.issuesTruncated === "boolean" ? source.issuesTruncated : undefined;
  const countersValid =
    inspectedCandidates !== undefined &&
    scannedEntries !== undefined &&
    scannedDirectories !== undefined &&
    inspectedCandidates <= scannedEntries &&
    assets.length <= inspectedCandidates &&
    issues.length <= inspectedCandidates &&
    (issuesTruncated === true || assets.length + issues.length <= inspectedCandidates);
  altered ||= !expectedKeys(source, ["assets", "issues", "inspectedCandidates", "scannedEntries", "scannedDirectories", "truncated", "issuesTruncated"]);
  if (!countersValid || truncated === undefined || issuesTruncated === undefined) return { report: null, altered: true };
  return {
    report: { assets, issues, inspectedCandidates, scannedEntries, scannedDirectories, truncated, issuesTruncated },
    altered,
  };
}

function statusView(value: unknown): { status: VisionToolkitStatusView; altered: boolean } {
  const source = ownDataRecord(value);
  if (source === undefined) return { status: { state: "idle" }, altered: true };
  if (source.state === "idle") return { status: { state: "idle" }, altered: !expectedKeys(source, ["state"]) };
  const operation = source.operation === "catalog" || source.operation === "info" ? source.operation : undefined;
  const at = canonicalTimestamp(source.at);
  const parsedPath = source.path === undefined ? { value: undefined, altered: false } : cleanedText(source.path, defaultLimits.pathCharacters);
  const pathValid = operation === "catalog" ? source.path === undefined : parsedPath.value !== undefined;
  if (operation === undefined || at === undefined || !pathValid) return { status: { state: "idle" }, altered: true };
  const path = parsedPath.value;
  if (source.state === "running") {
    return {
      status: { state: "running", operation, ...(path === undefined ? {} : { path }), at },
      altered: parsedPath.altered || !expectedKeys(source, ["state", "operation", ...(operation === "info" ? ["path"] : []), "at"]),
    };
  }
  if (source.state === "completed") {
    const count = integer(source.count, defaultLimits.assets);
    if (count === undefined || typeof source.truncated !== "boolean") return { status: { state: "idle" }, altered: true };
    return {
      status: { state: "completed", operation, ...(path === undefined ? {} : { path }), count, truncated: source.truncated, at },
      altered: parsedPath.altered || !expectedKeys(source, ["state", "operation", ...(operation === "info" ? ["path"] : []), "count", "truncated", "at"]),
    };
  }
  if (source.state === "failed" || source.state === "cancelled") {
    const error = cleanedText(source.error, defaultLimits.issueCharacters);
    if (error.value === undefined) return { status: { state: "idle" }, altered: true };
    return {
      status: { state: source.state, operation, ...(path === undefined ? {} : { path }), error: error.value, at },
      altered: parsedPath.altered || error.altered || !expectedKeys(source, ["state", "operation", ...(operation === "info" ? ["path"] : []), "error", "at"]),
    };
  }
  return { status: { state: "idle" }, altered: true };
}

function exactSupportedTypes(value: unknown): boolean {
  const parsed = ownDataArray(value, supportedTypes.length);
  if (parsed === undefined || parsed.altered || parsed.values.some((item) => typeof item !== "string")) return false;
  return new Set(parsed.values as string[]).size === supportedTypes.length && parsed.values.every((item) => supportedTypeSet.has(item as string));
}

function exactLimits(value: unknown): boolean {
  const source = ownDataRecord(value);
  if (source === undefined || !expectedKeys(source, Object.keys(defaultLimits))) return false;
  return Object.entries(defaultLimits).every(([key, expected]) => source[key] === expected);
}

export function visionToolkitPanelView(data: unknown): VisionToolkitPanelView {
  const source = ownDataRecord(data);
  if (source === undefined) {
    return { status: { state: "idle" }, report: null, supportedTypes: [...supportedTypes], limits: { ...defaultLimits }, truncated: true };
  }
  const parsedStatus = statusView(source.status);
  const parsedReport = reportView(source.report);
  const completionConsistent =
    parsedStatus.status.state !== "completed" ||
    (parsedReport.report !== null &&
      parsedStatus.status.count === parsedReport.report.assets.length &&
      parsedStatus.status.truncated === parsedReport.report.truncated &&
      (parsedStatus.status.operation === "catalog" || (parsedStatus.status.path === parsedReport.report.assets[0]?.path && parsedStatus.status.count === 1)));
  const truncated =
    parsedStatus.altered ||
    parsedReport.altered ||
    !completionConsistent ||
    !exactSupportedTypes(source.supportedTypes) ||
    !exactLimits(source.limits) ||
    !expectedKeys(source, ["status", "report", "supportedTypes", "limits"]);
  return {
    status: parsedStatus.status,
    report: parsedReport.report,
    supportedTypes: [...supportedTypes],
    limits: { ...defaultLimits },
    truncated,
  };
}
