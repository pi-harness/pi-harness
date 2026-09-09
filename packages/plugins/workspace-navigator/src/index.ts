import type { Dirent, Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
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
const ignoredDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);

export type WorkspaceNode = { kind: "directory" | "file"; name: string; path: string; depth: number };
export type WorkspaceNodeOptions = { maxDepth?: number; maxNodes?: number };
export type WorkspaceNodeReport = { nodes: WorkspaceNode[]; directoryCount: number; fileCount: number; truncated: boolean; scannedEntries: number };
export type WorkspaceGitStatusEntry = { path: string; status: string; originalPath?: string };
export type WorkspaceGitStatus = {
  available: boolean;
  branch: string | null;
  clean: boolean;
  entries: WorkspaceGitStatusEntry[];
  changedCount: number;
  truncated: boolean;
};

const execFileAsync = promisify(execFile);

export async function readWorkspaceGitStatus(root: string, requestedTimeoutMs = defaultGitTimeoutMs, signal?: AbortSignal): Promise<WorkspaceGitStatus> {
  const timeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.max(100, Math.min(60_000, Math.trunc(requestedTimeoutMs))) : defaultGitTimeoutMs;
  signal?.throwIfAborted();
  try {
    const args = ["--no-optional-locks", "-C", root, "-c", "core.fsmonitor=false"];
    const [branchResult, statusResult] = await Promise.all([
      execFileAsync("git", [...args, "branch", "--show-current"], { maxBuffer: 1024 * 1024, timeout: timeoutMs, signal }),
      execFileAsync("git", [...args, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs, signal }),
    ]);
    signal?.throwIfAborted();
    const records = statusResult.stdout.split("\0");
    const entries: WorkspaceGitStatusEntry[] = [];
    let changedCount = 0;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length < 4) continue;
      const status = record.slice(0, 2);
      const originalPath = /[RC]/u.test(status) ? records[++index] : undefined;
      changedCount += 1;
      if (entries.length < 500) entries.push({ status, path: record.slice(3), ...(originalPath === undefined ? {} : { originalPath }) });
    }
    return {
      available: true,
      branch: branchResult.stdout.trim() || null,
      clean: changedCount === 0,
      entries,
      changedCount,
      truncated: changedCount > entries.length,
    };
  } catch {
    signal?.throwIfAborted();
    return { available: false, branch: null, clean: false, entries: [], changedCount: 0, truncated: false };
  }
}

export interface WorkspaceNavigatorPluginConfig {
  gitTimeoutMs?: number;
}

export const Config: z<WorkspaceNavigatorPluginConfig> = z.object({ gitTimeoutMs: z.number().default(defaultGitTimeoutMs) });

function assertParameters(value: unknown, allowed: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace navigator parameters");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Workspace navigator parameters must be plain objects");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key)) ||
    Object.values(descriptors).some((item) => !("value" in item))
  )
    throw new Error("Invalid workspace navigator parameter");
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
  const workspace = resolve(root);
  const { maxDepth, maxNodes } = normalizeOptions(options);
  const nodes: WorkspaceNode[] = [];
  let truncated = false;
  let scannedEntries = 0;
  const readEntries = async (directory: string): Promise<Dirent[]> => {
    signal?.throwIfAborted();
    if (scannedEntries >= maxScannedEntries) {
      truncated = true;
      return [];
    }
    const handle = await opendir(directory);
    const entries: Dirent[] = [];
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
    if (depth > maxDepth) {
      try {
        const hiddenEntries = await readEntries(directory);
        if (hiddenEntries.some((entry) => (entry.isDirectory() ? !ignoredDirectories.has(entry.name) : entry.isFile()))) truncated = true;
      } catch {
        signal?.throwIfAborted();
        truncated = true;
      }
      return;
    }
    // An unreadable subdirectory or an entry that disappears between directory enumeration and lstat degrades to a truncated tree, because a partial listing is more useful to the caller than losing every node collected so far. The workspace root still fails loudly: an empty tree for a missing or unreadable root would be a misleading success.
    let entries: Dirent[];
    try {
      entries = (await readEntries(directory)).sort((left, right) => left.name.localeCompare(right.name));
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
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const target = resolve(directory, entry.name);
      if (!relative(workspace, target) || relative(workspace, target).startsWith(`..${"/"}`)) continue;
      let metadata: Stats;
      try {
        metadata = await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") truncated = true;
        continue;
      }
      if (metadata.isSymbolicLink()) continue;
      const path = relative(workspace, target);
      if (metadata.isDirectory()) {
        nodes.push({ kind: "directory", name: entry.name, path, depth });
        await visit(target, depth + 1);
      } else if (metadata.isFile()) {
        nodes.push({ kind: "file", name: entry.name, path, depth });
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
      const requested = requestedPath?.trim() ?? ".";
      if (requested.length > 512 || requested.includes("\\"))
        throw new Error("Workspace navigator path must be a relative POSIX path of at most 512 characters");
      const resolved = await resolveExistingWorkspacePath(operationScope.cwd, requested, "Workspace navigator path must stay inside the current workspace");
      const root = resolved.root;
      const target = resolved.target;
      const options = normalizeOptions({
        ...(requestedDepth === undefined ? {} : { maxDepth: requestedDepth }),
        ...(requestedNodes === undefined ? {} : { maxNodes: requestedNodes }),
      });
      const report = await listWorkspaceNodes(target, options, signal);
      signal.throwIfAborted();
      if (refreshScope() !== operationScope) throw new Error("Workspace changed during navigation");
      latest = { ...report, path: relative(root, target) || ".", ...options };
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
            path: Type.Optional(Type.String({ description: "Relative directory path" })),
            maxDepth: Type.Optional(Type.Number({ description: "Tree depth, 1-8" })),
            maxNodes: Type.Optional(Type.Number({ description: "Maximum nodes, 1-500" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<WorkspaceNodeReport & { path: string; maxDepth: number; maxNodes: number }>> {
          assertParameters(params, ["path", "maxDepth", "maxNodes"]);
          if (params.path !== undefined && typeof params.path !== "string") throw new Error("Invalid workspace navigator path parameter");
          const report = await inspect(
            params.path,
            params.maxDepth,
            params.maxNodes,
            signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]),
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(report),
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
            assertParameters(params, []);
            const operationScope = refreshScope();
            const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            const report = await readWorkspaceGitStatus(operationScope.cwd, gitTimeoutMs, operationSignal);
            operationSignal.throwIfAborted();
            if (refreshScope() !== operationScope) throw new Error("Workspace changed while reading Git status");
            latestGit = report;
            return { content: [{ type: "text", text: JSON.stringify(report) }], details: structuredClone(report) };
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
