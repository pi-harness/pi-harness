import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { listWorkspaceNodes, readWorkspaceGitStatus, type WorkspaceGitStatus, type WorkspaceNodeReport } from "@pi-harness/plugin-workspace-navigator";
import { EmptyConfig } from "@pi-harness/plugin-api";

const maxChangedFiles = 12;
const treeCacheTtlMs = 5_000;

export interface SidebarOverviewInput {
  readonly cwd: string;
  readonly gitAvailable: boolean;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly changedCount: number;
  readonly changedFiles: readonly { readonly path: string; readonly status: string }[];
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly sessionId: string;
}

export interface SidebarOverview extends SidebarOverviewInput {
  readonly summary: string;
}

export function summarizeSidebar(input: SidebarOverviewInput): SidebarOverview {
  const changedCount = input.changedCount;
  const summary = !input.gitAvailable
    ? `非 Git 工作区 · ${changedCount > 0 ? `${changedCount} 个变更` : "无变更"}`
    : `${input.branch ?? "detached HEAD"} · ${changedCount > 0 ? `${changedCount} 个变更` : "clean"}`;
  return {
    ...input,
    changedFiles: input.changedFiles.slice(0, maxChangedFiles),
    changedCount,
    truncated: input.truncated || changedCount > maxChangedFiles,
    summary,
  };
}

export function createSidebarInspector(input: {
  readonly cwd: string;
  readonly getSessionId: () => string;
  readonly listNodes?: (root: string, options: { maxDepth: number; maxNodes: number }) => Promise<WorkspaceNodeReport>;
  readonly readGitStatus?: (root: string) => Promise<WorkspaceGitStatus>;
  readonly now?: () => number;
}): () => Promise<SidebarOverview> {
  const readNodes = input.listNodes ?? listWorkspaceNodes;
  const readGit = input.readGitStatus ?? readWorkspaceGitStatus;
  const now = input.now ?? Date.now;
  let tree: { readonly report: WorkspaceNodeReport; readonly scannedAt: number } | undefined;
  let inFlight: Promise<SidebarOverview> | undefined;

  // The bounded workspace scan is cached only briefly so that files created during the session show up in the counts, while rapid panel polling still shares one scan.
  const readTree = (): Promise<WorkspaceNodeReport> => {
    const scannedAt = now();
    if (tree !== undefined && scannedAt - tree.scannedAt < treeCacheTtlMs) return Promise.resolve(tree.report);
    return readNodes(input.cwd, { maxDepth: 2, maxNodes: 80 }).then((result) => {
      tree = { report: result, scannedAt };
      return result;
    });
  };

  const inspect = async (): Promise<SidebarOverview> => {
    const [currentTree, git] = await Promise.all([readTree(), readGit(input.cwd)]);
    return summarizeSidebar({
      cwd: input.cwd,
      gitAvailable: git.available,
      branch: git.available ? git.branch : null,
      clean: git.available && git.clean,
      changedCount: git.changedCount,
      changedFiles: git.entries,
      directoryCount: currentTree.directoryCount,
      fileCount: currentTree.fileCount,
      truncated: currentTree.truncated || git.truncated,
      sessionId: input.getSessionId(),
    });
  };

  return () => {
    if (inFlight !== undefined) return inFlight;
    const current = inspect().finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    return current;
  };
}

function textSummary(report: SidebarOverview): string {
  const files = report.changedFiles
    .slice(0, 8)
    .map((entry) => `${entry.status} ${entry.path}`)
    .join(", ");
  return `${report.summary}; ${report.directoryCount} 个目录，${report.fileCount} 个文件${files ? `; ${files}` : ""}`;
}

export default {
  name: "pi-better-sidebar",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort(new Error("Better Sidebar plugin disposed")));
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      const manager = session?.sessionManager ?? context.piSession.manager;
      return { session, manager, header: manager.getHeader(), cwd: manager.getCwd(), sessionId: manager.getSessionId() };
    };
    const createScan = (scope: ReturnType<typeof readScope>) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifecycle.signal]);
      return {
        scope,
        controller,
        inspect: createSidebarInspector({
          cwd: scope.cwd,
          getSessionId: () => scope.sessionId,
          listNodes: (root, options) => listWorkspaceNodes(root, options, signal),
          readGitStatus: (root) => readWorkspaceGitStatus(root, undefined, signal),
        }),
      };
    };
    let scan = createScan(readScope());
    const refreshScan = () => {
      lifecycle.signal.throwIfAborted();
      const current = readScope();
      const previous = scan.scope;
      if (
        current.session !== previous.session ||
        current.manager !== previous.manager ||
        current.header !== previous.header ||
        current.cwd !== previous.cwd ||
        current.sessionId !== previous.sessionId
      ) {
        scan.controller.abort(new Error("Sidebar session changed during inspection"));
        scan = createScan(current);
      }
      return scan;
    };
    const inspect = async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const current = refreshScan();
      const report = await current.inspect();
      signal?.throwIfAborted();
      if (refreshScan() !== current) throw new Error("Sidebar session changed during inspection");
      return report;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "sidebar_overview",
        label: "Sidebar overview",
        description: "Read a compact workspace and Git overview for the current session without modifying files.",
        promptSnippet: "inspect the workspace overview shown in the sidebar",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, _params, signal): Promise<AgentToolResult<SidebarOverview>> {
          const report = await inspect(signal);
          return { content: [{ type: "text", text: textSummary(report) }], details: structuredClone(report) };
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "better-sidebar-panel",
      pluginId: "@pi-harness/plugin-better-sidebar",
      title: "Better Sidebar",
      description: "在会话旁显示当前工作区、Git 变更和文件概览。",
      icon: "▤",
      read: async () => structuredClone(await inspect()),
    });
    context.effect(() => disposePanel);
  },
};
