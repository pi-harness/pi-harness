import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { listWorkspaceNodes, readWorkspaceGitStatus } from "./workspace-navigator.js";

export interface SidebarOverviewInput {
  readonly cwd: string;
  readonly gitAvailable: boolean;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly changedFiles: readonly { readonly path: string; readonly status: string }[];
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly sessionId: string;
}

export interface SidebarOverview extends SidebarOverviewInput {
  readonly changedCount: number;
  readonly summary: string;
}

export function summarizeSidebar(input: SidebarOverviewInput): SidebarOverview {
  const changedCount = input.changedFiles.length;
  const summary = !input.gitAvailable
    ? `非 Git 工作区 · ${changedCount > 0 ? `${changedCount} 个变更` : "无变更"}`
    : `${input.branch ?? "detached HEAD"} · ${changedCount > 0 ? `${changedCount} 个变更` : "clean"}`;
  return { ...input, changedFiles: input.changedFiles.slice(0, 12), changedCount, summary };
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
  apply(context: Context) {
    let latest: SidebarOverview | undefined;
    const inspect = async (): Promise<SidebarOverview> => {
      const cwd = context.piHarnessLaunch.cwd;
      const [tree, git] = await Promise.all([listWorkspaceNodes(cwd, { maxDepth: 2, maxNodes: 80 }), readWorkspaceGitStatus(cwd)]);
      latest = summarizeSidebar({
        cwd,
        gitAvailable: git.available,
        branch: git.available ? git.branch : null,
        clean: git.available && git.clean,
        changedFiles: git.entries,
        directoryCount: tree.directoryCount,
        fileCount: tree.fileCount,
        truncated: tree.truncated,
        sessionId: context.piSession.manager.getSessionId(),
      });
      return latest;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "sidebar_overview",
        label: "Sidebar overview",
        description: "Read a compact workspace and Git overview for the current session without modifying files.",
        promptSnippet: "inspect the workspace overview shown in the sidebar",
        parameters: Type.Object({}),
        async execute(): Promise<AgentToolResult<SidebarOverview>> {
          const report = await inspect();
          return { content: [{ type: "text", text: textSummary(report) }], details: report };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "better-sidebar-panel",
      pluginId: "@pi-harness/core/plugins/better-sidebar",
      title: "Better Sidebar",
      description: "在会话旁显示当前工作区、Git 变更和文件概览。",
      icon: "▤",
      read: () => latest ?? inspect(),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
