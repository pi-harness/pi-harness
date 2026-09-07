import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
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
const defaultGitTimeoutMs = 10_000;
const ignoredDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);

export type WorkspaceNode = { kind: "directory" | "file"; name: string; path: string; depth: number };
export type WorkspaceNodeOptions = { maxDepth?: number; maxNodes?: number };
export type WorkspaceNodeReport = { nodes: WorkspaceNode[]; directoryCount: number; fileCount: number; truncated: boolean };
export type WorkspaceGitStatusEntry = { path: string; status: string };
export type WorkspaceGitStatus = { available: boolean; branch: string | null; clean: boolean; entries: WorkspaceGitStatusEntry[] };

const execFileAsync = promisify(execFile);

export async function readWorkspaceGitStatus(root: string, requestedTimeoutMs = defaultGitTimeoutMs): Promise<WorkspaceGitStatus> {
  const timeoutMs = Math.max(100, Math.min(60_000, Math.trunc(requestedTimeoutMs)));
  try {
    const [branchResult, statusResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "branch", "--show-current"], { maxBuffer: 1024 * 1024, timeout: timeoutMs }),
      execFileAsync("git", ["-C", root, "status", "--short", "--untracked-files=all"], { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs }),
    ]);
    const entries = statusResult.stdout
      .split("\n")
      .filter((line) => line.length >= 4)
      .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
    return { available: true, branch: branchResult.stdout.trim() || null, clean: entries.length === 0, entries };
  } catch {
    return { available: false, branch: null, clean: false, entries: [] };
  }
}

export interface WorkspaceNavigatorPluginConfig {
  gitTimeoutMs?: number;
}

export const Config: z<WorkspaceNavigatorPluginConfig> = z.object({ gitTimeoutMs: z.number().default(defaultGitTimeoutMs) });

function normalizeOptions(options: WorkspaceNodeOptions): { maxDepth: number; maxNodes: number } {
  return {
    maxDepth: Math.max(1, Math.min(maxDepthLimit, Math.trunc(options.maxDepth ?? 4))),
    maxNodes: Math.max(1, Math.min(maxNodesLimit, Math.trunc(options.maxNodes ?? 200))),
  };
}

export async function listWorkspaceNodes(root: string, options: WorkspaceNodeOptions = {}): Promise<WorkspaceNodeReport> {
  const workspace = resolve(root);
  const { maxDepth, maxNodes } = normalizeOptions(options);
  const nodes: WorkspaceNode[] = [];
  let truncated = false;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      try {
        const hiddenEntries = await readdir(directory, { withFileTypes: true });
        if (hiddenEntries.some((entry) => (entry.isDirectory() ? !ignoredDirectories.has(entry.name) : entry.isFile()))) truncated = true;
      } catch {
        truncated = true;
      }
      return;
    }
    // An unreadable subdirectory or an entry that disappears between readdir and lstat degrades to a truncated tree, because a partial listing is more useful to the caller than losing every node collected so far. The workspace root still fails loudly: an empty tree for a missing or unreadable root would be a misleading success.
    let entries: Dirent[];
    try {
      entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (directory === workspace) throw error;
      truncated = true;
      return;
    }
    for (const entry of entries) {
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
  return {
    nodes,
    directoryCount: nodes.filter((node) => node.kind === "directory").length,
    fileCount: nodes.filter((node) => node.kind === "file").length,
    truncated,
  };
}

export default {
  name: "pi-workspace-navigator",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: WorkspaceNavigatorPluginConfig) {
    const gitTimeoutMs = Math.max(100, Math.min(60_000, Math.trunc(config.gitTimeoutMs ?? defaultGitTimeoutMs)));
    let latest: (WorkspaceNodeReport & { path: string; maxDepth: number; maxNodes: number }) | undefined;
    let latestGit: WorkspaceGitStatus | undefined;
    const inspect = async (requestedPath: string | undefined, requestedDepth: number | undefined, requestedNodes: number | undefined) => {
      const requested = requestedPath?.trim() ?? ".";
      if (requested.length > 512 || requested.includes("\\"))
        throw new Error("Workspace navigator path must be a relative POSIX path of at most 512 characters");
      const resolved = await resolveExistingWorkspacePath(
        context.piHarnessLaunch.cwd,
        requested,
        "Workspace navigator path must stay inside the current workspace",
      );
      const root = resolved.root;
      const target = resolved.target;
      const options = normalizeOptions({
        ...(requestedDepth === undefined ? {} : { maxDepth: requestedDepth }),
        ...(requestedNodes === undefined ? {} : { maxNodes: requestedNodes }),
      });
      const report = await listWorkspaceNodes(target, options);
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
        async execute(_toolCallId, params): Promise<AgentToolResult<WorkspaceNodeReport & { path: string; maxDepth: number; maxNodes: number }>> {
          const report = await inspect(params.path, params.maxDepth, params.maxNodes);
          return {
            content: [
              {
                type: "text",
                text: report.nodes.map((node) => `${node.kind === "directory" ? "[dir]" : "[file]"} ${node.path}`).join("\n") || "Workspace is empty.",
              },
            ],
            details: report,
          };
        },
      }),
    );
    const unregisterGit = context.piTools.register(
      defineTool({
        name: "workspace_status",
        label: "Workspace status",
        description: "Show the current workspace Git branch and changed files without modifying the repository.",
        promptSnippet: "inspect the workspace Git status",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(): Promise<AgentToolResult<WorkspaceGitStatus>> {
          latestGit = await readWorkspaceGitStatus(context.piHarnessLaunch.cwd, gitTimeoutMs);
          const summary = latestGit.available
            ? `${latestGit.branch ?? "detached HEAD"}: ${latestGit.clean ? "clean" : `${latestGit.entries.length} changed file(s)`}`
            : "Not a Git workspace.";
          return { content: [{ type: "text", text: summary }], details: latestGit };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "workspace-navigator-panel",
      pluginId: "@pi-harness/plugin-workspace-navigator",
      title: "Workspace Navigator",
      description: "以受限目录树快速浏览当前工作区，不执行写操作。",
      icon: "⌘",
      read: () => ({ latest: latest ?? null, git: latestGit ?? null, nodeCount: latest?.nodes.length ?? 0, gitTimeoutMs }),
    });
    context.effect(() => () => {
      unregister();
      unregisterGit();
      disposePanel();
    });
  },
};
