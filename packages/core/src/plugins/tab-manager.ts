import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { readBoundedTextFile } from "../bounded-file.js";
import { EmptyConfig } from "../config.js";

const storageFile = "session-tabs.json";
const maxTabs = 24;
const maxStateFileBytes = 1024 * 1024;
const lockRetryMs = 25;
const lockTimeoutMs = 10_000;
type Tab = { id: string; label: string; sessionPath: string; pinned: boolean; updatedAt: string };
type TabState = { tabs: Tab[]; activeId: string | null };

function emptyState(): TabState {
  return { tabs: [], activeId: null };
}

async function readState(path: string): Promise<TabState> {
  let source: string;
  try {
    source = await readBoundedTextFile(path, maxStateFileBytes, "Session tab store");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Session tab store contains invalid JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Session tab store has an unsupported format");
  const value = parsed as { tabs?: unknown; activeId?: unknown };
  if (!Array.isArray(value.tabs) || (value.activeId !== null && typeof value.activeId !== "string"))
    throw new Error("Session tab store has an unsupported format");
  if (value.tabs.length > maxTabs) throw new Error(`Session tab store exceeds the ${maxTabs}-tab limit`);
  const tabs: Tab[] = [];
  for (const candidate of value.tabs) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Session tab store contains invalid tabs");
    const tab = candidate as Record<string, unknown>;
    if (
      typeof tab.id !== "string" ||
      tab.id.length === 0 ||
      tab.id.length > 512 ||
      typeof tab.label !== "string" ||
      tab.label.trim().length === 0 ||
      tab.label.length > 120 ||
      typeof tab.sessionPath !== "string" ||
      tab.sessionPath.length === 0 ||
      tab.sessionPath.length > 4_096 ||
      typeof tab.pinned !== "boolean" ||
      typeof tab.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(tab.updatedAt))
    )
      throw new Error("Session tab store contains invalid tabs");
    tabs.push(tab as Tab);
  }
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length || new Set(tabs.map((tab) => tab.sessionPath)).size !== tabs.length)
    throw new Error("Session tab store contains duplicate tabs");
  if (typeof value.activeId === "string" && !tabs.some((tab) => tab.id === value.activeId)) throw new Error("Session tab store contains an invalid active tab");
  return { tabs, activeId: value.activeId };
}

async function persist(path: string, state: TabState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquireTabLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
        throw new Error("Timed out waiting for session tab store lock", { cause: error });
      await new Promise<void>((resolve) => setTimeout(resolve, lockRetryMs));
    }
  }
}

export default {
  name: "pi-tab-manager",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  async apply(context: Context) {
    const path = join(context.piHarnessLaunch.agentDir, storageFile);
    let state = await readState(path);
    let mutationQueue = Promise.resolve();
    let writes = 0;
    const activeSession = (): { id: string; sessionPath: string } => ({
      id: context.piSession.manager.getSessionId(),
      sessionPath: context.piSession.manager.getSessionFile() ?? join(context.piHarnessLaunch.agentDir, `${context.piSession.manager.getSessionId()}.jsonl`),
    });
    const upsert = (current: TabState, id: string, sessionPath: string, label: string | undefined, pinned: boolean): Tab => {
      const now = new Date().toISOString();
      const existing = current.tabs.find((tab) => tab.id === id || tab.sessionPath === sessionPath);
      if (existing !== undefined) {
        existing.label = label?.trim() || existing.label;
        existing.pinned = pinned;
        existing.updatedAt = now;
        current.activeId = existing.id;
        return existing;
      }
      if (current.tabs.length >= maxTabs) throw new Error(`A maximum of ${maxTabs} session tabs is supported`);
      const tab = { id, label: label?.trim() || id, sessionPath, pinned, updatedAt: now };
      current.tabs = [tab, ...current.tabs];
      current.activeId = tab.id;
      return tab;
    };
    const mutate = async <T>(operation: (current: TabState) => T): Promise<T> => {
      let result: T | undefined;
      const run = async (): Promise<void> => {
        const release = await acquireTabLock(`${path}.lock`);
        try {
          const current = await readState(path);
          result = operation(current);
          await persist(path, current);
          state = current;
          writes += 1;
        } finally {
          await release();
        }
      };
      mutationQueue = mutationQueue.catch(() => undefined).then(run);
      await mutationQueue;
      return result as T;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "session_tab_manage",
        label: "Session tabs",
        description: "Pin, rename, activate, remove, or list lightweight session tabs without deleting session files.",
        promptSnippet: "organize open Pi sessions as named tabs",
        parameters: Type.Object(
          {
            action: Type.Union(["pin", "unpin", "rename", "activate", "remove", "list"]),
            sessionPath: Type.Optional(Type.String()),
            label: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<TabState | Tab>> {
          const active = activeSession();
          const targetPath = params.sessionPath?.trim() || active.sessionPath;
          if (params.label !== undefined && params.label.trim().length > 120) throw new Error("Tab label must be 1 to 120 characters");
          if (params.action === "list") {
            state = await readState(path);
            return { content: [{ type: "text", text: `${state.tabs.length} session tab(s).` }], details: state };
          }
          if (params.action === "activate") {
            const label = await mutate((current) => {
              const target = current.tabs.find((tab) => tab.sessionPath === targetPath);
              if (target === undefined) throw new Error("Session tab not found");
              current.activeId = target.id;
              target.updatedAt = new Date().toISOString();
              return target.label;
            });
            return { content: [{ type: "text", text: `Active session tab: ${label}` }], details: state };
          }
          if (params.action === "remove") {
            await mutate((current) => {
              const target = current.tabs.find((tab) => tab.sessionPath === targetPath);
              if (target === undefined) throw new Error("Session tab not found");
              current.tabs = current.tabs.filter((tab) => tab !== target);
              current.activeId = current.tabs[0]?.id ?? null;
            });
          } else if (params.action === "rename") {
            const label = params.label?.trim() ?? "";
            if (label.length === 0 || label.length > 120) throw new Error("Tab label must be 1 to 120 characters");
            await mutate((current) => {
              const target = current.tabs.find((tab) => tab.sessionPath === targetPath);
              if (target === undefined) throw new Error("Session tab not found");
              target.label = label;
              target.updatedAt = new Date().toISOString();
              current.activeId = target.id;
            });
          } else if (params.action === "pin") {
            const tab = await mutate((current) => upsert(current, active.id, targetPath, params.label, true));
            return { content: [{ type: "text", text: `Pinned session tab: ${tab.label}` }], details: tab };
          } else {
            await mutate((current) => {
              const target = current.tabs.find((tab) => tab.sessionPath === targetPath);
              if (target === undefined) throw new Error("Session tab not found");
              target.pinned = false;
              target.updatedAt = new Date().toISOString();
              current.activeId = target.id;
            });
          }
          return { content: [{ type: "text", text: `Session tabs: ${state.tabs.length}.` }], details: state };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "tab-manager-panel",
        pluginId: "@pi-harness/core/plugins/tab-manager",
        title: "Session Tabs",
        description: "管理命名会话标签；移除标签不会删除会话文件。",
        icon: "▣",
        read: async () => {
          state = await readState(path);
          return { activeId: state.activeId, tabs: state.tabs, writes };
        },
      });
    } catch (error) {
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
