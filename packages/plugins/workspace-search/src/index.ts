import type { Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, readBoundedFile, resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const maxQueryLength = 256;
const maxPathLength = 512;
const maxFileBytes = 2 * 1024 * 1024;
const maxFiles = 2_000;
const maxScannedEntries = 4096;
const maxTotalBytes = 64 * 1024 * 1024;
const maxDirectories = 512;
const maxDepth = 16;
const maxResults = 100;
const maxMatchTextLength = 500;
const maxSerializedReportBytes = 128 * 1024;
const ignoredDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);
type SearchMatch = { path: string; line: number; text: string };
type SearchReport = {
  query: string;
  path: string;
  matches: SearchMatch[];
  matchCount: number;
  scannedFiles: number;
  skippedFiles: number;
  truncated: boolean;
  scannedEntries: number;
  readBytes: number;
};

type PathSemantics = { isAbsolute(path: string): boolean; relative(from: string, to: string): string; sep: string };
const nativePathSemantics: PathSemantics = { isAbsolute, relative, sep };

export function isWorkspaceSearchPathInside(root: string, target: string, pathSemantics: PathSemantics = nativePathSemantics): boolean {
  const remainder = pathSemantics.relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${pathSemantics.sep}`) && !pathSemantics.isAbsolute(remainder));
}

export function workspaceSearchRelativePath(root: string, target: string, pathSemantics: PathSemantics = nativePathSemantics): string {
  const remainder = pathSemantics.relative(root, target);
  return remainder === "" ? "." : remainder.split(pathSemantics.sep).join("/");
}

export function isWorkspaceSearchIgnoredDirectory(name: string, caseInsensitive = process.platform === "win32" || process.platform === "darwin"): boolean {
  return ignoredDirectories.has(caseInsensitive ? name.toLowerCase() : name);
}

function targetsIgnoredDirectory(root: string, target: string, targetIsDirectory: boolean): boolean {
  const relativeTarget = workspaceSearchRelativePath(root, target);
  if (relativeTarget === ".") return false;
  const segments = relativeTarget.split("/");
  const directories = targetIsDirectory ? segments : segments.slice(0, -1);
  return directories.some((name) => isWorkspaceSearchIgnoredDirectory(name));
}

type WalkState = { files: string[]; directories: number; scannedEntries: number; truncated: boolean };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Workspace search was cancelled", { cause: signal.reason });
}

async function filesUnder(target: string, root: string, state: WalkState, signal: AbortSignal | undefined, depth = 0): Promise<boolean> {
  throwIfAborted(signal);
  if (state.files.length >= maxFiles || state.directories >= maxDirectories || depth > maxDepth) return true;
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    throwIfAborted(signal);
    if (depth === 0) throw error;
    state.truncated = true;
    return false;
  }
  if (metadata.isSymbolicLink()) return false;
  if (targetsIgnoredDirectory(root, target, metadata.isDirectory())) return false;
  if (metadata.isFile()) {
    state.files.push(target);
    return false;
  }
  if (!metadata.isDirectory()) return false;
  state.directories += 1;
  if (depth >= maxDepth) return true;
  if (state.scannedEntries >= maxScannedEntries) return true;
  const entries: Dirent[] = [];
  try {
    const handle = await opendir(target);
    try {
      while (state.scannedEntries < maxScannedEntries) {
        throwIfAborted(signal);
        const entry = await handle.read();
        if (entry === null) break;
        state.scannedEntries += 1;
        entries.push(entry);
      }
      if (state.scannedEntries >= maxScannedEntries) state.truncated = true;
    } finally {
      await handle.close();
    }
  } catch (error) {
    throwIfAborted(signal);
    if (depth === 0) throw error;
    state.truncated = true;
    return false;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (state.files.length >= maxFiles || state.directories >= maxDirectories) return true;
    if (entry.isDirectory() && isWorkspaceSearchIgnoredDirectory(entry.name)) continue;
    const child = resolve(target, entry.name);
    if (!isWorkspaceSearchPathInside(root, child)) continue;
    if (await filesUnder(child, root, state, signal, depth + 1)) return true;
  }
  return false;
}

type SearchParameters = { query?: unknown; path?: unknown; caseSensitive?: unknown; maxResults?: unknown };

function snapshotParameters(params: unknown): SearchParameters {
  try {
    if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid workspace search parameters");
    const prototype = Object.getPrototypeOf(params) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Workspace search parameters must be plain objects");
    const allowed = new Set(["query", "path", "caseSensitive", "maxResults"]);
    const keys = Reflect.ownKeys(params);
    if (keys.length > allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error("Invalid workspace search parameter");
    const snapshot = Object.create(null) as SearchParameters;
    for (const key of keys as (keyof SearchParameters)[]) {
      const descriptor = Object.getOwnPropertyDescriptor(params, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("Invalid workspace search parameter");
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error instanceof Error && /^Invalid workspace search|^Workspace search parameters/u.test(error.message)) throw error;
    throw new Error("Invalid workspace search parameter", { cause: error });
  }
}

function boundSerializedReport(report: SearchReport): string {
  let serialized = JSON.stringify(report);
  while (Buffer.byteLength(serialized, "utf8") > maxSerializedReportBytes && report.matches.length > 0) {
    report.matches.pop();
    report.matchCount = report.matches.length;
    report.truncated = true;
    serialized = JSON.stringify(report);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxSerializedReportBytes) throw new Error("Workspace search report exceeds its serialization budget");
  return serialized;
}

function matchExcerpt(line: string, normalizedIndex: number, caseSensitive: boolean): string {
  if (line.length <= maxMatchTextLength) return line;
  let sourceIndex = normalizedIndex;
  if (!caseSensitive) {
    sourceIndex = 0;
    let foldedIndex = 0;
    for (const char of line) {
      if (foldedIndex >= normalizedIndex) break;
      foldedIndex += char.toLowerCase().length;
      sourceIndex += char.length;
    }
  }
  let start = Math.max(0, sourceIndex - 120);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(line[start]!)) start -= 1;
  let end = Math.min(line.length, start + maxMatchTextLength);
  if (end < line.length && /[\uDC00-\uDFFF]/u.test(line[end]!)) end -= 1;
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

export default {
  name: "pi-workspace-search",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: SearchReport | undefined;
    const lifecycle = new AbortController();
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, sessionId: session?.sessionId, cwd: session?.sessionManager.getCwd() ?? context.piHarnessLaunch.cwd };
    };
    let scope = readScope();
    const refreshScope = () => {
      throwIfAborted(lifecycle.signal);
      const current = readScope();
      if (current.session !== scope.session || current.manager !== scope.manager || current.sessionId !== scope.sessionId || current.cwd !== scope.cwd) {
        scope = current;
        latest = undefined;
      }
      return scope;
    };
    const search = async (
      query: string,
      requestedPath: string | undefined,
      caseSensitive: boolean,
      requestedLimit: number | undefined,
      signal: AbortSignal | undefined,
    ): Promise<SearchReport> => {
      throwIfAborted(signal);
      const operationScope = refreshScope();
      if (query.length > maxQueryLength) throw new Error(`Workspace search query must contain 1-${maxQueryLength} characters`);
      if (query.includes("\0")) throw new Error("Workspace search query must not contain NUL characters");
      const normalizedQuery = query.trim();
      if (normalizedQuery.length === 0) throw new Error(`Workspace search query must contain 1-${maxQueryLength} characters`);
      const rawPath = requestedPath ?? ".";
      if (rawPath.length > maxPathLength) throw new Error("Workspace search path must be a relative POSIX path of at most 512 characters");
      if (rawPath.includes("\0")) throw new Error("Workspace search path must not contain NUL characters");
      const requested = rawPath.trim() || ".";
      if (requested.includes("\\")) throw new Error("Workspace search path must be a relative POSIX path of at most 512 characters");
      // Canonicalise both ends before the containment check so a symlinked intermediate directory cannot lead outside the workspace.
      const resolved = await resolveExistingWorkspacePath(operationScope.cwd, requested, "Workspace search path must stay inside the current workspace");
      const root = resolved.root;
      const target = resolved.target;
      const targetMetadata = await lstat(target);
      if (targetsIgnoredDirectory(root, target, targetMetadata.isDirectory())) throw new Error("Workspace search path targets an ignored directory");
      const walkState: WalkState = { files: [], directories: 0, scannedEntries: 0, truncated: false };
      const filesTruncated = await filesUnder(target, root, walkState, signal);
      const files = walkState.files;
      const limit = Math.max(1, Math.min(maxResults, Math.trunc(requestedLimit ?? maxResults)));
      const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLowerCase();
      const matches: SearchMatch[] = [];
      let readBytes = 0;
      let remainingReadBudget = maxTotalBytes;
      let scannedFiles = 0;
      let skippedFiles = 0;
      let stoppedAtLimit = false;
      let clippedText = false;
      for (const file of files) {
        throwIfAborted(signal);
        if (matches.length >= limit) {
          stoppedAtLimit = true;
          break;
        }
        let source: string;
        try {
          if (remainingReadBudget <= 0) {
            stoppedAtLimit = true;
            break;
          }
          const resolvedFile = await resolveExistingWorkspacePath(root, relative(root, file), "Workspace search file must stay inside the current workspace");
          const metadata = await lstat(resolvedFile.target);
          if (!metadata.isFile() || metadata.size > maxFileBytes) {
            skippedFiles += 1;
            continue;
          }
          const allowance = Math.min(maxFileBytes, remainingReadBudget);
          remainingReadBudget -= allowance;
          const bytes = await readBoundedFile(resolvedFile.target, allowance, "Workspace search file");
          remainingReadBudget += allowance - bytes.length;
          readBytes += bytes.length;
          throwIfAborted(signal);
          if (bytes.includes(0)) {
            skippedFiles += 1;
            continue;
          }
          source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throwIfAborted(signal);
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const lines = source.split(/\r?\n/u);
        for (const [index, line] of lines.entries()) {
          const matchIndex = (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
          if (matchIndex >= 0) {
            // A minified bundle or a single-line JSON document is one legitimate line of up to maxFileBytes, so each match text is clipped before it reaches the agent content and the panel state.
            const clipped = line.length > maxMatchTextLength;
            if (clipped) clippedText = true;
            matches.push({ path: workspaceSearchRelativePath(root, file), line: index + 1, text: matchExcerpt(line, matchIndex, caseSensitive) });
            if (matches.length >= limit) {
              stoppedAtLimit = true;
              break;
            }
          }
        }
      }
      const report: SearchReport = {
        query: normalizedQuery,
        path: workspaceSearchRelativePath(root, target),
        matches,
        matchCount: matches.length,
        scannedFiles,
        skippedFiles,
        truncated: filesTruncated || walkState.truncated || stoppedAtLimit || clippedText || skippedFiles > 0,
        scannedEntries: walkState.scannedEntries,
        readBytes,
      };
      boundSerializedReport(report);
      throwIfAborted(signal);
      if (refreshScope() !== operationScope) throw new Error("Workspace changed during search");
      latest = report;
      return report;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "workspace_search",
        label: "Search workspace",
        description: "Search bounded UTF-8 text files in the current workspace without modifying files or invoking a shell.",
        promptSnippet: "search the workspace for a text pattern",
        parameters: Type.Object(
          {
            query: Type.String({ maxLength: maxQueryLength }),
            path: Type.Optional(Type.String({ maxLength: maxPathLength })),
            caseSensitive: Type.Optional(Type.Boolean()),
            maxResults: Type.Optional(Type.Number()),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SearchReport>> {
          const snapshot = snapshotParameters(params);
          if (typeof snapshot.query !== "string") throw new Error("Invalid workspace search query parameter");
          if (snapshot.path !== undefined && typeof snapshot.path !== "string") throw new Error("Invalid workspace search path parameter");
          if (snapshot.caseSensitive !== undefined && typeof snapshot.caseSensitive !== "boolean")
            throw new Error("Invalid workspace search caseSensitive parameter");
          if (snapshot.maxResults !== undefined && (typeof snapshot.maxResults !== "number" || !Number.isFinite(snapshot.maxResults)))
            throw new Error("Invalid workspace search maxResults parameter");
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const report = await search(snapshot.query, snapshot.path, snapshot.caseSensitive === true, snapshot.maxResults, operationSignal);
          return {
            content: [{ type: "text", text: boundSerializedReport(report) }],
            details: structuredClone(report),
          };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "workspace-search-panel",
        pluginId: "@pi-harness/plugin-workspace-search",
        title: "Workspace Search",
        description: "在工作区内安全检索文本，跳过依赖、构建产物和版本库目录。",
        icon: "⌕",
        read: () => {
          const current = refreshScope();
          return {
            cwd: current.cwd,
            latest: latest === undefined ? null : structuredClone(latest),
            query: latest?.query ?? null,
            matchCount: latest?.matchCount ?? 0,
            scannedFiles: latest?.scannedFiles ?? 0,
          };
        },
      });
    } catch (error) {
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort();
      unregisterTool();
      disposePanel();
    });
  },
};
