import type { Dirent, Stats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { lstat, opendir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const maxDepthLimit = 8;
const maxNodesLimit = 500;
const maxScannedEntries = 4096;
const defaultGitTimeoutMs = 10_000;
const maxPathLength = 512;
const maxSerializedReportBytes = 128 * 1024;
const ignoredDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);

export type WorkspaceNode = { kind: "directory" | "file"; name: string; path: string; depth: number };
export type WorkspaceNodeOptions = { maxDepth?: number; maxNodes?: number };
export type WorkspaceNodeReport = { nodes: WorkspaceNode[]; directoryCount: number; fileCount: number; truncated: boolean; scannedEntries: number };
export type WorkspaceGitStatusEntry = { path: string; status: string; originalPath?: string };
export type WorkspaceGitFailureReason = "not-repository" | "timeout" | "git-unavailable" | "output-limit" | "invalid-output" | "git-error";
export type WorkspaceGitStatus = {
  available: boolean;
  failureReason: WorkspaceGitFailureReason | null;
  branch: string | null;
  clean: boolean;
  entries: WorkspaceGitStatusEntry[];
  changedCount: number;
  truncated: boolean;
};

const execFileAsync = promisify(execFile);

type PathSemantics = { isAbsolute(path: string): boolean; relative(from: string, to: string): string; sep: string };
const nativePathSemantics: PathSemantics = { isAbsolute, relative, sep };

export function workspaceNavigatorRelativePath(root: string, target: string, pathSemantics: PathSemantics = nativePathSemantics): string {
  const remainder = pathSemantics.relative(root, target);
  return remainder === "" ? "." : remainder.split(pathSemantics.sep).join("/");
}

function isWorkspaceNavigatorPathInside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

export function isWorkspaceNavigatorIgnoredDirectory(name: string, caseInsensitive = process.platform === "win32" || process.platform === "darwin"): boolean {
  return ignoredDirectories.has(caseInsensitive ? name.toLowerCase() : name);
}

function targetsIgnoredDirectory(root: string, target: string): boolean {
  const path = workspaceNavigatorRelativePath(root, target);
  return path !== "." && path.split("/").some((name) => isWorkspaceNavigatorIgnoredDirectory(name));
}

function boundTreeReport(report: WorkspaceNodeReport & { path: string; maxDepth: number; maxNodes: number }): string {
  let serialized = JSON.stringify(report);
  while (Buffer.byteLength(serialized, "utf8") > maxSerializedReportBytes && report.nodes.length > 0) {
    report.nodes.pop();
    report.directoryCount = report.nodes.filter((node) => node.kind === "directory").length;
    report.fileCount = report.nodes.length - report.directoryCount;
    report.truncated = true;
    serialized = JSON.stringify(report);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxSerializedReportBytes) throw new Error("Workspace navigator report exceeds its serialization budget");
  return serialized;
}

function boundGitReport(report: WorkspaceGitStatus): string {
  let serialized = JSON.stringify(report);
  while (Buffer.byteLength(serialized, "utf8") > maxSerializedReportBytes && report.entries.length > 0) {
    report.entries.pop();
    report.truncated = report.changedCount > report.entries.length;
    serialized = JSON.stringify(report);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxSerializedReportBytes) throw new Error("Workspace Git status exceeds its serialization budget");
  return serialized;
}

function decodeUtf8(value: Buffer): string | undefined {
  return isUtf8(value) ? value.toString("utf8") : undefined;
}

export function parseWorkspaceGitStatusOutput(output: Buffer, repositoryPrefix = ""): Pick<WorkspaceGitStatus, "entries" | "changedCount" | "truncated"> {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start !== output.length) throw new Error("Invalid Git status output");
  const entries: WorkspaceGitStatusEntry[] = [];
  let changedCount = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length === 0) continue;
    if (record.length < 4 || record[2] !== 0x20) throw new Error("Invalid Git status output");
    const status = record.subarray(0, 2).toString("ascii");
    if (!/^[ MADRCUT?!]{2}$/u.test(status)) throw new Error("Invalid Git status output");
    const renamed = /[RC]/u.test(status);
    const originalRecord = renamed ? records[++index] : undefined;
    if (renamed && (originalRecord === undefined || originalRecord.length === 0)) throw new Error("Invalid Git status output");
    changedCount += 1;
    const makeRelative = (value: Buffer): string | undefined => {
      const decoded = decodeUtf8(value);
      if (decoded === undefined) return undefined;
      if (repositoryPrefix === "") return decoded;
      return decoded.startsWith(repositoryPrefix) ? decoded.slice(repositoryPrefix.length) : undefined;
    };
    const path = makeRelative(record.subarray(3));
    const originalPath = originalRecord === undefined ? undefined : makeRelative(originalRecord);
    if (path === undefined || (renamed && originalPath === undefined)) continue;
    if (entries.length < 500) entries.push(originalPath === undefined ? { status, path } : { status, path, originalPath });
  }
  return { entries, changedCount, truncated: changedCount > entries.length };
}

function unavailableGitStatus(failureReason: WorkspaceGitFailureReason): WorkspaceGitStatus {
  return { available: false, failureReason, branch: null, clean: false, entries: [], changedCount: 0, truncated: false };
}

function gitFailureReason(error: unknown): WorkspaceGitFailureReason {
  const details = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string | Buffer };
  const stderr = Buffer.isBuffer(details.stderr) ? details.stderr.toString("utf8") : (details.stderr ?? "");
  if (details.code === "ENOENT") return "git-unavailable";
  if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/iu.test(details.message ?? "")) return "output-limit";
  if (details.killed === true || details.code === "ETIMEDOUT" || details.signal === "SIGTERM") return "timeout";
  if (/not a git repository/iu.test(stderr)) return "not-repository";
  return details.message === "Invalid Git status output" ? "invalid-output" : "git-error";
}

export async function readWorkspaceGitStatus(root: string, requestedTimeoutMs = defaultGitTimeoutMs, signal?: AbortSignal): Promise<WorkspaceGitStatus> {
  const timeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.max(100, Math.min(60_000, Math.trunc(requestedTimeoutMs))) : defaultGitTimeoutMs;
  signal?.throwIfAborted();
  try {
    const args = ["--no-optional-locks", "-C", root, "-c", "core.fsmonitor=false"];
    const [branchResult, prefixResult, statusResult] = await Promise.all([
      execFileAsync("git", [...args, "branch", "--show-current"], { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: timeoutMs, signal }),
      execFileAsync("git", [...args, "rev-parse", "--show-prefix"], { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: timeoutMs, signal }),
      execFileAsync("git", [...args, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], {
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
        signal,
      }),
    ]);
    signal?.throwIfAborted();
    const prefix = decodeUtf8(prefixResult.stdout);
    if (prefix === undefined) throw new Error("Invalid Git status output");
    const parsed = parseWorkspaceGitStatusOutput(statusResult.stdout, prefix.trimEnd());
    const branch = decodeUtf8(branchResult.stdout);
    if (branch === undefined) throw new Error("Invalid Git status output");
    const report: WorkspaceGitStatus = {
      available: true,
      failureReason: null,
      branch: branch.trim() || null,
      clean: parsed.changedCount === 0,
      ...parsed,
    };
    boundGitReport(report);
    return report;
  } catch (error) {
    signal?.throwIfAborted();
    return unavailableGitStatus(gitFailureReason(error));
  }
}

export interface WorkspaceNavigatorPluginConfig {
  gitTimeoutMs?: number;
}

export const Config: z<WorkspaceNavigatorPluginConfig> = z.object({ gitTimeoutMs: z.number().default(defaultGitTimeoutMs) });

function snapshotParameters(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace navigator parameters");
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Workspace navigator parameters must be plain objects");
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length || keys.some((key) => typeof key !== "string" || !allowed.includes(key)))
      throw new Error("Invalid workspace navigator parameter");
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("Invalid workspace navigator parameter");
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error instanceof Error && /^Invalid workspace navigator|^Workspace navigator parameters/u.test(error.message)) throw error;
    throw new Error("Invalid workspace navigator parameter", { cause: error });
  }
}

function normalizeOptions(options: WorkspaceNodeOptions): { maxDepth: number; maxNodes: number } {
  for (const [key, value] of Object.entries(options)) {
    if (!["maxDepth", "maxNodes"].includes(key) || (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))))
      throw new Error(`Invalid workspace navigator ${key}`);
  }
  return {
    maxDepth: Math.max(1, Math.min(maxDepthLimit, Math.trunc(options.maxDepth ?? 4))),
    maxNodes: Math.max(1, Math.min(maxNodesLimit, Math.trunc(options.maxNodes ?? 200))),
  };
}

export async function listWorkspaceNodes(root: string, options: WorkspaceNodeOptions = {}, signal?: AbortSignal): Promise<WorkspaceNodeReport> {
  signal?.throwIfAborted();
  const workspace = await realpath(resolve(root));
  const { maxDepth, maxNodes } = normalizeOptions(options);
  const nodes: WorkspaceNode[] = [];
  let truncated = false;
  let scannedEntries = 0;
  const readEntries = async (directory: string): Promise<Dirent<Buffer>[]> => {
    signal?.throwIfAborted();
    if (scannedEntries >= maxScannedEntries) {
      truncated = true;
      return [];
    }
    const handle = (await opendir(directory, { encoding: "buffer" as unknown as BufferEncoding })) as unknown as {
      read(): Promise<Dirent<Buffer> | null>;
      close(): Promise<void>;
    };
    const entries: Dirent<Buffer>[] = [];
    try {
      while (scannedEntries < maxScannedEntries) {
        signal?.throwIfAborted();
        const entry = await handle.read();
        if (entry === null) return entries;
        scannedEntries += 1;
        entries.push(entry);
      }
      truncated = true;
      return entries;
    } finally {
      await handle.close();
    }
  };
  const visit = async (directory: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    try {
      const metadata = await lstat(directory);
      const canonical = await realpath(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || !isWorkspaceNavigatorPathInside(workspace, canonical)) {
        if (directory === workspace) throw new Error("Workspace navigator root must identify a contained directory");
        truncated = true;
        return;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (directory === workspace) throw error;
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      try {
        const hiddenEntries = await readEntries(directory);
        for (const entry of hiddenEntries) {
          const name = decodeUtf8(entry.name);
          if (name === undefined) {
            truncated = true;
            continue;
          }
          const target = resolve(directory, name);
          try {
            const metadata = await lstat(target);
            if (metadata.isSymbolicLink()) continue;
            if (metadata.isDirectory() && isWorkspaceNavigatorIgnoredDirectory(name)) continue;
            if (metadata.isDirectory() || metadata.isFile()) truncated = true;
          } catch {
            truncated = true;
          }
        }
      } catch {
        signal?.throwIfAborted();
        truncated = true;
      }
      return;
    }
    // An unreadable subdirectory or an entry that disappears between directory enumeration and lstat degrades to a truncated tree, because a partial listing is more useful to the caller than losing every node collected so far. The workspace root still fails loudly: an empty tree for a missing or unreadable root would be a misleading success.
    let entries: Dirent<Buffer>[];
    try {
      entries = (await readEntries(directory)).sort((left, right) => Buffer.compare(left.name, right.name));
    } catch (error) {
      signal?.throwIfAborted();
      if (directory === workspace) throw error;
      truncated = true;
      return;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (nodes.length >= maxNodes) {
        truncated = true;
        return;
      }
      const name = decodeUtf8(entry.name);
      if (name === undefined) {
        truncated = true;
        continue;
      }
      if (entry.isDirectory() && isWorkspaceNavigatorIgnoredDirectory(name)) continue;
      const target = resolve(directory, name);
      if (!isWorkspaceNavigatorPathInside(workspace, target) || target === workspace) continue;
      let metadata: Stats;
      try {
        metadata = await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") truncated = true;
        continue;
      }
      if (metadata.isSymbolicLink()) {
        if (entry.isDirectory()) truncated = true;
        continue;
      }
      if (metadata.isDirectory() && isWorkspaceNavigatorIgnoredDirectory(name)) continue;
      const path = workspaceNavigatorRelativePath(workspace, target);
      if (metadata.isDirectory()) {
        try {
          const currentMetadata = await lstat(target);
          const canonical = await realpath(target);
          if (currentMetadata.isSymbolicLink() || !currentMetadata.isDirectory() || !isWorkspaceNavigatorPathInside(workspace, canonical)) {
            truncated = true;
            continue;
          }
        } catch {
          signal?.throwIfAborted();
          truncated = true;
          continue;
        }
        nodes.push({ kind: "directory", name, path, depth });
        await visit(target, depth + 1);
      } else if (metadata.isFile()) {
        nodes.push({ kind: "file", name, path, depth });
      }
    }
  };
  await visit(workspace, 1);
  signal?.throwIfAborted();
  return {
    nodes,
    directoryCount: nodes.filter((node) => node.kind === "directory").length,
    fileCount: nodes.filter((node) => node.kind === "file").length,
    truncated,
    scannedEntries,
  };
}

export default {
  name: "pi-workspace-navigator",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: WorkspaceNavigatorPluginConfig) {
    if (config.gitTimeoutMs !== undefined && !Number.isFinite(config.gitTimeoutMs)) throw new Error("Invalid workspace navigator gitTimeoutMs");
    const gitTimeoutMs = Math.max(100, Math.min(60_000, Math.trunc(config.gitTimeoutMs ?? defaultGitTimeoutMs)));
    let latest: (WorkspaceNodeReport & { path: string; maxDepth: number; maxNodes: number }) | undefined;
    let latestGit: WorkspaceGitStatus | undefined;
    const lifecycle = new AbortController();
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, sessionId: session?.sessionId, cwd: session?.sessionManager.getCwd() ?? context.piHarnessLaunch.cwd };
    };
    let scope = readScope();
    const refreshScope = () => {
      lifecycle.signal.throwIfAborted();
      const current = readScope();
      if (current.session !== scope.session || current.manager !== scope.manager || current.sessionId !== scope.sessionId || current.cwd !== scope.cwd) {
        scope = current;
        latest = undefined;
        latestGit = undefined;
      }
      return scope;
    };
    const inspect = async (requestedPath: string | undefined, requestedDepth: number | undefined, requestedNodes: number | undefined, signal: AbortSignal) => {
      signal.throwIfAborted();
      const operationScope = refreshScope();
      const rawPath = requestedPath ?? ".";
      if (rawPath.length > maxPathLength) throw new Error("Workspace navigator path must be a relative POSIX path of at most 512 characters");
      if (rawPath.includes("\0")) throw new Error("Workspace navigator path must not contain NUL characters");
      const requested = rawPath.trim() || ".";
      if (requested.includes("\\")) throw new Error("Workspace navigator path must be a relative POSIX path of at most 512 characters");
      const resolved = await resolveExistingWorkspacePath(operationScope.cwd, requested, "Workspace navigator path must stay inside the current workspace");
      const root = resolved.root;
      const target = resolved.target;
      const targetMetadata = await lstat(target);
      if (!targetMetadata.isDirectory()) throw new Error("Workspace navigator path must identify a directory");
      if (targetsIgnoredDirectory(root, target)) throw new Error("Workspace navigator path targets an ignored directory");
      const options = normalizeOptions({
        ...(requestedDepth === undefined ? {} : { maxDepth: requestedDepth }),
        ...(requestedNodes === undefined ? {} : { maxNodes: requestedNodes }),
      });
      const report = await listWorkspaceNodes(target, options, signal);
      signal.throwIfAborted();
      if (refreshScope() !== operationScope) throw new Error("Workspace changed during navigation");
      latest = { ...report, path: workspaceNavigatorRelativePath(root, target), ...options };
      boundTreeReport(latest);
      return latest;
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "workspace_tree",
        label: "Workspace tree",
        description: "Show a bounded, read-only workspace tree while skipping dependency and build directories.",
        promptSnippet: "inspect the workspace directory tree",
        parameters: Type.Object(
          {
            path: Type.Optional(Type.String({ description: "Relative directory path", maxLength: maxPathLength })),
            maxDepth: Type.Optional(Type.Number({ description: "Tree depth, 1-8" })),
            maxNodes: Type.Optional(Type.Number({ description: "Maximum nodes, 1-500" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<WorkspaceNodeReport & { path: string; maxDepth: number; maxNodes: number }>> {
          const snapshot = snapshotParameters(params, ["path", "maxDepth", "maxNodes"]);
          if (snapshot.path !== undefined && typeof snapshot.path !== "string") throw new Error("Invalid workspace navigator path parameter");
          const report = await inspect(
            snapshot.path,
            snapshot.maxDepth as number | undefined,
            snapshot.maxNodes as number | undefined,
            signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]),
          );
          return {
            content: [
              {
                type: "text",
                text: boundTreeReport(report),
              },
            ],
            details: structuredClone(report),
          };
        },
      }),
    );
    let unregisterGit: (() => void) | undefined;
    let disposePanel: (() => void) | undefined;
    try {
      unregisterGit = context.piTools.register(
        defineTool({
          name: "workspace_status",
          label: "Workspace status",
          description: "Show the current workspace Git branch and changed files without modifying the repository.",
          promptSnippet: "inspect the workspace Git status",
          parameters: Type.Object({}, { additionalProperties: false }),
          executionMode: "sequential",
          async execute(_toolCallId, params, signal): Promise<AgentToolResult<WorkspaceGitStatus>> {
            snapshotParameters(params, []);
            const operationScope = refreshScope();
            const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            const report = await readWorkspaceGitStatus(operationScope.cwd, gitTimeoutMs, operationSignal);
            operationSignal.throwIfAborted();
            if (refreshScope() !== operationScope) throw new Error("Workspace changed while reading Git status");
            latestGit = report;
            return { content: [{ type: "text", text: boundGitReport(report) }], details: structuredClone(report) };
          },
        }),
      );
      disposePanel = context.piPluginUi.register({
        id: "workspace-navigator-panel",
        pluginId: "@pi-harness/plugin-workspace-navigator",
        title: "Workspace Navigator",
        description: "以受限目录树快速浏览当前工作区，不执行写操作。",
        icon: "⌘",
        read: () => {
          const current = refreshScope();
          return {
            cwd: current.cwd,
            latest: latest === undefined ? null : structuredClone(latest),
            git: latestGit === undefined ? null : structuredClone(latestGit),
            nodeCount: latest?.nodes.length ?? 0,
            gitTimeoutMs,
          };
        },
      });
    } catch (error) {
      lifecycle.abort();
      disposePanel?.();
      unregisterGit?.();
      unregister();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort();
      unregister();
      unregisterGit?.();
      disposePanel?.();
    });
  },
};
