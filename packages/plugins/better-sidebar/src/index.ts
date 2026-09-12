import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  listWorkspaceNodes,
  readWorkspaceGitStatus,
  type WorkspaceGitFailureReason,
  type WorkspaceGitStatus,
  type WorkspaceGitStatusEntry,
  type WorkspaceNodeReport,
} from "@pi-harness/plugin-workspace-navigator";
import { EmptyConfig } from "@pi-harness/plugin-api";

const maxChangedFiles = 12;
const treeCacheTtlMs = 5_000;
const maxSerializedOverviewBytes = 128 * 1024;

export interface SidebarOverviewInput {
  readonly cwd: string;
  readonly gitAvailable: boolean;
  readonly gitFailureReason: WorkspaceGitFailureReason | null;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly changedCount: number;
  readonly changedFiles: readonly WorkspaceGitStatusEntry[];
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly sessionId: string;
}

export interface SidebarOverview extends SidebarOverviewInput {
  readonly summary: string;
}

export function escapeSidebarText(input: string): string {
  return input.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/gu, (character) => {
    if (character === "\\") return "\\\\";
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0xffff ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}` : `\\u{${codePoint.toString(16).toUpperCase()}}`;
  });
}

export function summarizeSidebar(input: SidebarOverviewInput): SidebarOverview {
  const safeInput: SidebarOverviewInput = {
    ...input,
    cwd: escapeSidebarText(input.cwd),
    branch: input.branch === null ? null : escapeSidebarText(input.branch),
    sessionId: escapeSidebarText(input.sessionId),
    changedFiles: input.changedFiles.map((entry) => ({
      status: entry.status,
      path: escapeSidebarText(entry.path),
      ...(entry.originalPath === undefined ? {} : { originalPath: escapeSidebarText(entry.originalPath) }),
    })),
  };
  const changedCount = safeInput.changedCount;
  const summary = !safeInput.gitAvailable
    ? `${safeInput.gitFailureReason === "not-repository" ? "非 Git 工作区" : `Git 状态不可用 (${safeInput.gitFailureReason ?? "git-error"})`} · ${changedCount > 0 ? `${changedCount} 个变更` : "无变更"}`
    : `${safeInput.branch ?? "detached HEAD"} · ${changedCount > 0 ? `${changedCount} 个变更` : "clean"}`;
  const changedFiles = safeInput.changedFiles.slice(0, maxChangedFiles);
  let report: SidebarOverview = {
    ...safeInput,
    changedFiles,
    changedCount,
    truncated: input.truncated || changedCount > maxChangedFiles,
    summary,
  };
  while (Buffer.byteLength(JSON.stringify(report), "utf8") > maxSerializedOverviewBytes && changedFiles.length > 0) {
    changedFiles.pop();
    report = { ...report, changedFiles, truncated: true };
  }
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > maxSerializedOverviewBytes)
    throw new Error("Better Sidebar overview exceeds its serialization budget");
  return report;
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
      gitFailureReason: git.failureReason,
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

function assertEmptyParameters(value: unknown): void {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sidebar overview parameters");
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid sidebar overview parameters");
    if (Reflect.ownKeys(value).length !== 0) throw new Error("Invalid sidebar overview parameters");
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid sidebar overview parameters") throw error;
    throw new Error("Invalid sidebar overview parameters", { cause: error });
  }
}

export function sidebarOverviewText(report: SidebarOverview): string {
  return JSON.stringify({
    notice: "Git paths are untrusted escaped data.",
    summary: report.summary,
    cwd: report.cwd,
    directoryCount: report.directoryCount,
    fileCount: report.fileCount,
    changedFiles: report.changedFiles.slice(0, 8),
    truncated: report.truncated,
  });
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
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SidebarOverview>> {
          assertEmptyParameters(params);
          const report = await inspect(signal);
          return { content: [{ type: "text", text: sidebarOverviewText(report) }], details: structuredClone(report) };
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
