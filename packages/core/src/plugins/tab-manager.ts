import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const storageFile = "session-tabs.json";
const maxTabs = 24;
type Tab = { id: string; label: string; sessionPath: string; pinned: boolean; updatedAt: string };
type TabState = { tabs: Tab[]; activeId: string | null };

function emptyState(): TabState {
  return { tabs: [], activeId: null };
}

async function readState(path: string): Promise<TabState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    const value = parsed as { tabs?: unknown; activeId?: unknown };
    const tabs = Array.isArray(value.tabs)
      ? value.tabs.filter(
          (tab): tab is Tab =>
            tab !== null &&
            typeof tab === "object" &&
            typeof (tab as { id?: unknown }).id === "string" &&
            typeof (tab as { label?: unknown }).label === "string" &&
            typeof (tab as { sessionPath?: unknown }).sessionPath === "string" &&
            typeof (tab as { pinned?: unknown }).pinned === "boolean" &&
            typeof (tab as { updatedAt?: unknown }).updatedAt === "string",
        )
      : [];
    return { tabs: tabs.slice(0, maxTabs), activeId: typeof value.activeId === "string" ? value.activeId : null };
  } catch {
    return emptyState();
  }
}

async function persist(path: string, state: TabState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export default {
  name: "pi-tab-manager",
  inject: ["piHarnessLaunch", "piRuntime", "piPluginUi", "piTools"],
  async apply(context: Context) {
    const path = join(context.piHarnessLaunch.agentDir, storageFile);
    let state = await readState(path);
    let writes = 0;
    const activeSession = (): { id: string; sessionPath: string } => ({
      id: context.piRuntime.session.sessionId,
      sessionPath: context.piRuntime.session.sessionFile ?? join(context.piHarnessLaunch.agentDir, `${context.piRuntime.session.sessionId}.jsonl`),
    });
    const upsert = (id: string, sessionPath: string, label: string | undefined, pinned: boolean): Tab => {
      const now = new Date().toISOString();
      const existing = state.tabs.find((tab) => tab.id === id || tab.sessionPath === sessionPath);
      if (existing !== undefined) {
        existing.label = label?.trim() || existing.label;
        existing.pinned = pinned;
        existing.updatedAt = now;
        state.activeId = existing.id;
        return existing;
      }
      if (state.tabs.length >= maxTabs) throw new Error(`A maximum of ${maxTabs} session tabs is supported`);
      const tab = { id, label: label?.trim() || id, sessionPath, pinned, updatedAt: now };
      state.tabs = [tab, ...state.tabs];
      state.activeId = tab.id;
      return tab;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "session_tab_manage",
        label: "Session tabs",
        description: "Pin, rename, remove, or list lightweight session tabs without deleting session files.",
        promptSnippet: "organize open Pi sessions as named tabs",
        parameters: Type.Object({
          action: Type.Union(["pin", "unpin", "rename", "remove", "list"]),
          sessionPath: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<TabState | Tab>> {
          const active = activeSession();
          const targetPath = params.sessionPath?.trim() || active.sessionPath;
          const target = state.tabs.find((tab) => tab.sessionPath === targetPath);
          if (params.action === "list") return { content: [{ type: "text", text: `${state.tabs.length} session tab(s).` }], details: state };
          if (params.action === "remove") {
            if (target === undefined) throw new Error("Session tab not found");
            state.tabs = state.tabs.filter((tab) => tab !== target);
            state.activeId = state.tabs[0]?.id ?? null;
          } else if (params.action === "rename") {
            if (target === undefined) throw new Error("Session tab not found");
            const label = params.label?.trim() ?? "";
            if (label.length === 0 || label.length > 120) throw new Error("Tab label must be 1 to 120 characters");
            target.label = label;
            target.updatedAt = new Date().toISOString();
            state.activeId = target.id;
          } else {
            const tab = upsert(active.id, targetPath, params.label, params.action === "pin");
            await persist(path, state);
            writes += 1;
            return { content: [{ type: "text", text: `${params.action === "pin" ? "Pinned" : "Unpinned"} session tab: ${tab.label}` }], details: tab };
          }
          await persist(path, state);
          writes += 1;
          return { content: [{ type: "text", text: `Session tabs: ${state.tabs.length}.` }], details: state };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "tab-manager-panel",
      pluginId: "@pi-harness/core/plugins/tab-manager",
      title: "Session Tabs",
      description: "管理命名会话标签；移除标签不会删除会话文件。",
      icon: "▣",
      read: () => ({ activeId: state.activeId, tabs: state.tabs, writes }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
