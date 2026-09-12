export type BetterSidebarGitFailureReason = "not-repository" | "timeout" | "git-unavailable" | "output-limit" | "invalid-output" | "git-error";

export interface BetterSidebarChangedFileView {
  readonly path: string;
  readonly status: string;
  readonly originalPath?: string;
}

export interface BetterSidebarPanelView {
  readonly cwd: string;
  readonly gitAvailable: boolean;
  readonly gitFailureReason: BetterSidebarGitFailureReason | null;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly changedCount: number;
  readonly changedFiles: readonly BetterSidebarChangedFileView[];
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly sessionId: string;
  readonly summary: string;
  readonly malformed: boolean;
}

const rootKeys = new Set([
  "cwd",
  "gitAvailable",
  "gitFailureReason",
  "branch",
  "clean",
  "changedCount",
  "changedFiles",
  "directoryCount",
  "fileCount",
  "truncated",
  "sessionId",
  "summary",
]);
const changedFileKeys = new Set(["path", "status", "originalPath"]);
const requiredChangedFileKeys = new Set(["path", "status"]);
const failureReasons = new Set(["not-repository", "timeout", "git-unavailable", "output-limit", "invalid-output", "git-error"]);
const maxSerializedOverviewBytes = 128 * 1024;

function ownDataRecord(value: unknown, keys: ReadonlySet<string>, required: ReadonlySet<string> = keys): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length < required.size ||
      ownKeys.length > keys.size ||
      ownKeys.some((key) => typeof key !== "string" || !keys.has(key)) ||
      [...required].some((key) => !ownKeys.includes(key))
    )
      return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function ownDataArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor !== undefined && "value" in lengthDescriptor ? (lengthDescriptor.value as unknown) : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== (length as number) + 1) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ? value : undefined;
}

function integer(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function relativePath(value: unknown): string | undefined {
  const path = text(value, 32_768);
  if (path === undefined || path.startsWith("/")) return undefined;
  const segments = path.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..") ? undefined : path;
}

function malformedView(): BetterSidebarPanelView {
  return {
    cwd: "",
    gitAvailable: false,
    gitFailureReason: null,
    branch: null,
    clean: false,
    changedCount: 0,
    changedFiles: [],
    directoryCount: 0,
    fileCount: 0,
    truncated: false,
    sessionId: "",
    summary: "",
    malformed: true,
  };
}

export function betterSidebarPanelView(value: unknown, activeSessionId?: string): BetterSidebarPanelView {
  const source = ownDataRecord(value, rootKeys);
  if (source === undefined || typeof source.gitAvailable !== "boolean" || typeof source.clean !== "boolean" || typeof source.truncated !== "boolean")
    return malformedView();
  const cwd = text(source.cwd, 32_768);
  const branch = source.branch === null ? null : text(source.branch, 4_096);
  const changedCount = integer(source.changedCount, 1_048_576);
  const rawFiles = ownDataArray(source.changedFiles, 12);
  const directoryCount = integer(source.directoryCount, 80);
  const fileCount = integer(source.fileCount, 80);
  const sessionId = text(source.sessionId, 4_096);
  const summary = text(source.summary, 32_768);
  if (
    cwd === undefined ||
    branch === undefined ||
    changedCount === undefined ||
    rawFiles === undefined ||
    directoryCount === undefined ||
    fileCount === undefined ||
    directoryCount + fileCount > 80 ||
    sessionId === undefined ||
    summary === undefined
  )
    return malformedView();
  const changedFiles = rawFiles.map((entry) => {
    const record = ownDataRecord(entry, changedFileKeys, requiredChangedFileKeys);
    const path = relativePath(record?.path);
    if (record === undefined || path === undefined || typeof record.status !== "string" || !/^[ MADRCUT?!]{2}$/u.test(record.status)) return undefined;
    const renamed = /[RC]/u.test(record.status);
    const originalPath = record.originalPath === undefined ? undefined : relativePath(record.originalPath);
    if ((renamed && originalPath === undefined) || (!renamed && record.originalPath !== undefined)) return undefined;
    return originalPath === undefined ? { path, status: record.status } : { path, status: record.status, originalPath };
  });
  if (changedFiles.some((entry) => entry === undefined)) return malformedView();
  const normalizedFiles = changedFiles as BetterSidebarChangedFileView[];
  if (normalizedFiles.length > changedCount || new Set(normalizedFiles.map((entry) => entry.path)).size !== normalizedFiles.length) return malformedView();
  let gitFailureReason: BetterSidebarGitFailureReason | null;
  if (source.gitAvailable) {
    if (source.gitFailureReason !== null || source.clean !== (changedCount === 0) || (changedCount > normalizedFiles.length && !source.truncated))
      return malformedView();
    gitFailureReason = null;
  } else {
    if (!failureReasons.has(source.gitFailureReason as string) || branch !== null || source.clean || changedCount !== 0 || normalizedFiles.length !== 0)
      return malformedView();
    gitFailureReason = source.gitFailureReason as BetterSidebarGitFailureReason;
  }
  const result: BetterSidebarPanelView = {
    cwd,
    gitAvailable: source.gitAvailable,
    gitFailureReason,
    branch,
    clean: source.clean,
    changedCount,
    changedFiles: normalizedFiles,
    directoryCount,
    fileCount,
    truncated: source.truncated,
    sessionId,
    summary,
    malformed: false,
  };
  return (activeSessionId === undefined || result.sessionId === activeSessionId) &&
    new TextEncoder().encode(JSON.stringify(result)).length <= maxSerializedOverviewBytes
    ? result
    : malformedView();
}
