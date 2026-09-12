export interface WorkspaceSearchMatchView {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface WorkspaceSearchReportView {
  readonly query: string;
  readonly path: string;
  readonly matches: readonly WorkspaceSearchMatchView[];
  readonly matchCount: number;
  readonly scannedFiles: number;
  readonly skippedFiles: number;
  readonly truncated: boolean;
  readonly scannedEntries: number;
  readonly readBytes: number;
}

export interface WorkspaceSearchPanelView {
  readonly cwd: string;
  readonly latest: WorkspaceSearchReportView | null;
  readonly query: string | null;
  readonly matchCount: number;
  readonly scannedFiles: number;
  readonly malformed: boolean;
}

const rootKeys = new Set(["cwd", "latest", "query", "matchCount", "scannedFiles"]);
const reportKeys = new Set(["query", "path", "matches", "matchCount", "scannedFiles", "skippedFiles", "truncated", "scannedEntries", "readBytes"]);
const matchKeys = new Set(["path", "line", "text"]);
const maxResults = 100;
const maxFiles = 2_000;
const maxScannedEntries = 4_096;
const maxTotalBytes = 64 * 1024 * 1024;
const maxFileBytes = 2 * 1024 * 1024;
const maxCanonicalPathLength = 32_768;

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
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
    if (
      keys.length !== (length as number) + 1 ||
      keys.some(
        (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= (length as number)),
      )
    )
      return undefined;
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

function safeInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function exactQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() && !value.includes("\0") ? value : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0") ? value : undefined;
}

function canonicalRelativePath(value: unknown, allowRoot: boolean): string | undefined {
  const path = boundedText(value, maxCanonicalPathLength);
  if (path === undefined || path.startsWith("/")) return undefined;
  if (allowRoot && path === ".") return path;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return path;
}

function searchMatch(value: unknown): WorkspaceSearchMatchView | undefined {
  const source = ownDataRecord(value, matchKeys);
  if (source === undefined) return undefined;
  const path = canonicalRelativePath(source.path, false);
  const line = safeInteger(source.line, maxFileBytes + 1);
  const text = boundedText(source.text, 502);
  if (path === undefined || line === undefined || line === 0 || text === undefined) return undefined;
  return { path, line, text };
}

function searchReport(value: unknown): WorkspaceSearchReportView | undefined {
  const source = ownDataRecord(value, reportKeys);
  if (source === undefined) return undefined;
  const query = exactQuery(source.query);
  const path = canonicalRelativePath(source.path, true);
  const rawMatches = ownDataArray(source.matches, maxResults);
  const matchCount = safeInteger(source.matchCount, maxResults);
  const scannedFiles = safeInteger(source.scannedFiles, maxFiles);
  const skippedFiles = safeInteger(source.skippedFiles, maxFiles);
  const scannedEntries = safeInteger(source.scannedEntries, maxScannedEntries);
  const readBytes = safeInteger(source.readBytes, maxTotalBytes);
  if (
    query === undefined ||
    path === undefined ||
    rawMatches === undefined ||
    matchCount === undefined ||
    scannedFiles === undefined ||
    skippedFiles === undefined ||
    scannedFiles + skippedFiles > maxFiles ||
    scannedEntries === undefined ||
    readBytes === undefined ||
    typeof source.truncated !== "boolean" ||
    rawMatches.length !== matchCount ||
    (!source.truncated && (matchCount >= maxResults || skippedFiles > 0 || scannedEntries >= maxScannedEntries))
  )
    return undefined;
  const matches = rawMatches.map(searchMatch);
  if (matches.some((match) => match === undefined)) return undefined;
  const normalized = matches as WorkspaceSearchMatchView[];
  if (new Set(normalized.map((match) => `${match.path}\0${match.line}`)).size !== normalized.length) return undefined;
  return {
    query,
    path,
    matches: normalized,
    matchCount,
    scannedFiles,
    skippedFiles,
    truncated: source.truncated,
    scannedEntries,
    readBytes,
  };
}

function malformedView(): WorkspaceSearchPanelView {
  return { cwd: "", latest: null, query: null, matchCount: 0, scannedFiles: 0, malformed: true };
}

export function workspaceSearchPanelView(data: unknown): WorkspaceSearchPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined) return malformedView();
  const cwd = boundedText(source.cwd, maxCanonicalPathLength);
  const matchCount = safeInteger(source.matchCount, maxResults);
  const scannedFiles = safeInteger(source.scannedFiles, maxFiles);
  if (cwd === undefined || matchCount === undefined || scannedFiles === undefined) return malformedView();
  if (source.latest === null) {
    if (source.query !== null || matchCount !== 0 || scannedFiles !== 0) return malformedView();
    return { cwd, latest: null, query: null, matchCount: 0, scannedFiles: 0, malformed: false };
  }
  const latest = searchReport(source.latest);
  if (latest === undefined || source.query !== latest.query || matchCount !== latest.matchCount || scannedFiles !== latest.scannedFiles) return malformedView();
  return { cwd, latest, query: latest.query, matchCount, scannedFiles, malformed: false };
}
