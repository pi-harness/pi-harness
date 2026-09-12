export interface WorkspaceNavigatorNodeView {
  readonly kind: "directory" | "file";
  readonly name: string;
  readonly path: string;
  readonly depth: number;
}

export interface WorkspaceNavigatorTreeView {
  readonly nodes: readonly WorkspaceNavigatorNodeView[];
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly scannedEntries: number;
  readonly path: string;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export interface WorkspaceNavigatorGitEntryView {
  readonly path: string;
  readonly status: string;
  readonly originalPath?: string;
}

export interface WorkspaceNavigatorGitView {
  readonly available: boolean;
  readonly failureReason: WorkspaceNavigatorGitFailureReason | null;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly entries: readonly WorkspaceNavigatorGitEntryView[];
  readonly changedCount: number;
  readonly truncated: boolean;
}

export type WorkspaceNavigatorGitFailureReason = "not-repository" | "timeout" | "git-unavailable" | "output-limit" | "invalid-output" | "git-error";

export interface WorkspaceNavigatorPanelView {
  readonly cwd: string;
  readonly latest: WorkspaceNavigatorTreeView | null;
  readonly git: WorkspaceNavigatorGitView | null;
  readonly nodeCount: number;
  readonly gitTimeoutMs: number;
  readonly malformed: boolean;
}

const rootKeys = new Set(["cwd", "latest", "git", "nodeCount", "gitTimeoutMs"]);
const treeKeys = new Set(["nodes", "directoryCount", "fileCount", "truncated", "scannedEntries", "path", "maxDepth", "maxNodes"]);
const nodeKeys = new Set(["kind", "name", "path", "depth"]);
const gitKeys = new Set(["available", "failureReason", "branch", "clean", "entries", "changedCount", "truncated"]);
const gitEntryKeys = new Set(["status", "path", "originalPath"]);
const requiredGitEntryKeys = new Set(["status", "path"]);
const maxNodes = 500;
const maxDepth = 8;
const maxScannedEntries = 4_096;
const maxGitEntries = 500;
const maxGitChanges = 1_048_576;
const maxPathLength = 32_768;
const maxSerializedReportBytes = 128 * 1024;

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>, required: ReadonlySet<string> = allowed): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < required.size ||
      keys.length > allowed.size ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      [...required].some((key) => !keys.includes(key))
    )
      return undefined;
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

function safeInteger(value: unknown, maximum: number, minimum = 0): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0") ? value : undefined;
}

function canonicalRelativePath(value: unknown, allowRoot: boolean): string | undefined {
  const path = boundedText(value, maxPathLength);
  if (path === undefined || path.startsWith("/")) return undefined;
  if (allowRoot && path === ".") return path;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return path;
}

function isWithinSerializationBudget(value: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).length <= maxSerializedReportBytes;
}

function navigatorNode(value: unknown): WorkspaceNavigatorNodeView | undefined {
  const source = ownDataRecord(value, nodeKeys);
  if (source === undefined || (source.kind !== "directory" && source.kind !== "file")) return undefined;
  const name = boundedText(source.name, maxPathLength);
  const path = canonicalRelativePath(source.path, false);
  const depth = safeInteger(source.depth, maxDepth, 1);
  if (name === undefined || path === undefined || depth === undefined || path.split("/").at(-1) !== name) return undefined;
  return { kind: source.kind, name, path, depth };
}

function treeReport(value: unknown): WorkspaceNavigatorTreeView | undefined {
  const source = ownDataRecord(value, treeKeys);
  if (source === undefined || typeof source.truncated !== "boolean") return undefined;
  const rawNodes = ownDataArray(source.nodes, maxNodes);
  const directoryCount = safeInteger(source.directoryCount, maxNodes);
  const fileCount = safeInteger(source.fileCount, maxNodes);
  const scannedEntries = safeInteger(source.scannedEntries, maxScannedEntries);
  const path = canonicalRelativePath(source.path, true);
  const maximumDepth = safeInteger(source.maxDepth, maxDepth, 1);
  const maximumNodes = safeInteger(source.maxNodes, maxNodes, 1);
  if (
    rawNodes === undefined ||
    directoryCount === undefined ||
    fileCount === undefined ||
    scannedEntries === undefined ||
    path === undefined ||
    maximumDepth === undefined ||
    maximumNodes === undefined ||
    rawNodes.length > maximumNodes ||
    directoryCount + fileCount !== rawNodes.length ||
    (!source.truncated && scannedEntries >= maxScannedEntries)
  )
    return undefined;
  const nodes = rawNodes.map(navigatorNode);
  if (nodes.some((node) => node === undefined)) return undefined;
  const normalized = nodes as WorkspaceNavigatorNodeView[];
  if (
    normalized.some((node) => node.depth > maximumDepth) ||
    scannedEntries < normalized.length ||
    normalized.filter((node) => node.kind === "directory").length !== directoryCount ||
    new Set(normalized.map((node) => node.path)).size !== normalized.length
  )
    return undefined;
  const priorDirectories = new Set<string>();
  for (const node of normalized) {
    const segments = node.path.split("/");
    if (segments.length !== node.depth || (node.depth > 1 && !priorDirectories.has(segments.slice(0, -1).join("/")))) return undefined;
    if (node.kind === "directory") priorDirectories.add(node.path);
  }
  const report: WorkspaceNavigatorTreeView = {
    nodes: normalized,
    directoryCount,
    fileCount,
    truncated: source.truncated,
    scannedEntries,
    path,
    maxDepth: maximumDepth,
    maxNodes: maximumNodes,
  };
  return isWithinSerializationBudget(report) ? report : undefined;
}

function gitEntry(value: unknown): WorkspaceNavigatorGitEntryView | undefined {
  const source = ownDataRecord(value, gitEntryKeys, requiredGitEntryKeys);
  const path = canonicalRelativePath(source?.path, false);
  if (source === undefined || path === undefined || typeof source.status !== "string" || !/^[ MADRCUT?!]{2}$/u.test(source.status)) return undefined;
  const renamed = /[RC]/u.test(source.status);
  const originalPath = source.originalPath === undefined ? undefined : canonicalRelativePath(source.originalPath, false);
  if ((renamed && originalPath === undefined) || (!renamed && source.originalPath !== undefined)) return undefined;
  return originalPath === undefined ? { status: source.status, path } : { status: source.status, path, originalPath };
}

function gitReport(value: unknown): WorkspaceNavigatorGitView | undefined {
  const source = ownDataRecord(value, gitKeys);
  if (source === undefined || typeof source.available !== "boolean" || typeof source.clean !== "boolean" || typeof source.truncated !== "boolean")
    return undefined;
  const rawEntries = ownDataArray(source.entries, maxGitEntries);
  const changedCount = safeInteger(source.changedCount, maxGitChanges);
  if (rawEntries === undefined || changedCount === undefined) return undefined;
  if (!source.available) {
    const failureReasons = new Set(["not-repository", "timeout", "git-unavailable", "output-limit", "invalid-output", "git-error"]);
    if (
      !failureReasons.has(source.failureReason as string) ||
      source.branch !== null ||
      source.clean ||
      rawEntries.length !== 0 ||
      changedCount !== 0 ||
      source.truncated
    )
      return undefined;
    return {
      available: false,
      failureReason: source.failureReason as WorkspaceNavigatorGitFailureReason,
      branch: null,
      clean: false,
      entries: [],
      changedCount: 0,
      truncated: false,
    };
  }
  if (source.failureReason !== null) return undefined;
  const branch = source.branch === null ? null : boundedText(source.branch, 4_096);
  if (branch === undefined || (branch !== null && branch !== branch.trim())) return undefined;
  const entries = rawEntries.map(gitEntry);
  if (entries.some((entry) => entry === undefined)) return undefined;
  const normalized = entries as WorkspaceNavigatorGitEntryView[];
  if (
    normalized.length > changedCount ||
    source.clean !== (changedCount === 0) ||
    source.truncated !== changedCount > normalized.length ||
    new Set(normalized.map((entry) => entry.path)).size !== normalized.length
  )
    return undefined;
  const report: WorkspaceNavigatorGitView = {
    available: true,
    failureReason: null,
    branch,
    clean: source.clean,
    entries: normalized,
    changedCount,
    truncated: source.truncated,
  };
  return isWithinSerializationBudget(report) ? report : undefined;
}

function malformedView(): WorkspaceNavigatorPanelView {
  return { cwd: "", latest: null, git: null, nodeCount: 0, gitTimeoutMs: 0, malformed: true };
}

export function workspaceNavigatorPanelView(data: unknown): WorkspaceNavigatorPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined) return malformedView();
  const cwd = boundedText(source.cwd, maxPathLength);
  const nodeCount = safeInteger(source.nodeCount, maxNodes);
  const gitTimeoutMs = safeInteger(source.gitTimeoutMs, 60_000, 100);
  const latest = source.latest === null ? null : treeReport(source.latest);
  const git = source.git === null ? null : gitReport(source.git);
  if (cwd === undefined || nodeCount === undefined || gitTimeoutMs === undefined) return malformedView();
  if (source.latest !== null && latest === undefined) return malformedView();
  if (source.git !== null && git === undefined) return malformedView();
  const normalizedLatest = latest ?? null;
  const normalizedGit = git ?? null;
  if (normalizedLatest === null ? nodeCount !== 0 : nodeCount !== normalizedLatest.nodes.length) return malformedView();
  return { cwd, latest: normalizedLatest, git: normalizedGit, nodeCount, gitTimeoutMs, malformed: false };
}
