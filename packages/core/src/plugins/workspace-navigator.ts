import { lstat, readdir, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxDepthLimit = 8;
const maxNodesLimit = 500;
const ignoredDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);

export type WorkspaceNode = { kind: "directory" | "file"; name: string; path: string; depth: number };
export type WorkspaceNodeOptions = { maxDepth?: number; maxNodes?: number };
export type WorkspaceNodeReport = { nodes: WorkspaceNode[]; directoryCount: number; fileCount: number; truncated: boolean };

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
    if (depth > maxDepth || nodes.length >= maxNodes) {
      if (nodes.length >= maxNodes) truncated = true;
      return;
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        return;
      }
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const target = resolve(directory, entry.name);
      if (!relative(workspace, target) || relative(workspace, target).startsWith(`..${"/"}`)) continue;
      const metadata = await lstat(target);
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

function inside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${"/"}`) && !remainder.startsWith("/"));
}

function workspacePath(root: string, requested: string): string {
  if (requested.length > 512 || requested.includes("\\")) throw new Error("Workspace navigator path must be a relative POSIX path of at most 512 characters");
  const target = resolve(root, requested || ".");
  if (!inside(root, target)) throw new Error("Workspace navigator path must stay inside the current workspace");
  return target;
}

export default {
  name: "pi-workspace-navigator",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: (WorkspaceNodeReport & { path: string; maxDepth: number; maxNodes: number }) | undefined;
    const inspect = async (requestedPath: string | undefined, requestedDepth: number | undefined, requestedNodes: number | undefined) => {
      const root = await realpath(context.piHarnessLaunch.cwd);
      const target = workspacePath(root, requestedPath?.trim() ?? ".");
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
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: "Relative directory path" })),
          maxDepth: Type.Optional(Type.Number({ description: "Tree depth, 1-8" })),
          maxNodes: Type.Optional(Type.Number({ description: "Maximum nodes, 1-500" })),
        }),
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
    const disposePanel = context.piPluginUi.register({
      id: "workspace-navigator-panel",
      pluginId: "@pi-harness/core/plugins/workspace-navigator",
      title: "Workspace Navigator",
      description: "以受限目录树快速浏览当前工作区，不执行写操作。",
      icon: "⌘",
      read: () => ({ latest: latest ?? null, nodeCount: latest?.nodes.length ?? 0 }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
