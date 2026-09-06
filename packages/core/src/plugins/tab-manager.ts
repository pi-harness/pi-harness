import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { BoundedFileSizeError, BoundedFileTypeError, readBoundedTextFile } from "../bounded-file.js";
import { EmptyConfig } from "../config.js";

const storageFile = "session-tabs.json";
const maxTabs = 24;
const maxStateFileBytes = 1024 * 1024;
const lockRetryMs = 25;
const lockTimeoutMs = 10_000;
const staleLockMs = 30_000;
const maxLockOwnerBytes = 1024;
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

function tabLockOwnerIsAlive(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pid = (value as Record<string, unknown>).pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function reclaimStaleTabLock(lockPath: string, lockMetadata: Awaited<ReturnType<typeof lstat>>): Promise<boolean> {
  if (Date.now() - Number(lockMetadata.mtimeMs) <= staleLockMs) return false;
  let directory;
  try {
    directory = await opendir(lockPath, { bufferSize: 1 });
  } catch {
    return false;
  }
  let ownerName: string | undefined;
  try {
    const owner = await directory.read();
    const extra = await directory.read();
    if (owner === null || extra !== null || !/^[a-z0-9-]{1,64}\.owner$/iu.test(owner.name)) return false;
    ownerName = owner.name;
  } finally {
    await directory.close().catch(() => undefined);
  }
  const ownerPath = resolve(lockPath, ownerName);
  let ownerMetadata;
  try {
    ownerMetadata = await lstat(ownerPath);
  } catch {
    return false;
  }
  if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || Date.now() - Number(ownerMetadata.mtimeMs) <= staleLockMs) return false;
  let owner: unknown;
  try {
    owner = JSON.parse(await readBoundedTextFile(ownerPath, maxLockOwnerBytes, "Session tab lock owner")) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) return false;
  }
  if (tabLockOwnerIsAlive(owner) === true) return false;
  let currentLockMetadata;
  let currentOwnerMetadata;
  try {
    [currentLockMetadata, currentOwnerMetadata] = await Promise.all([lstat(lockPath), lstat(ownerPath)]);
  } catch {
    return false;
  }
  if (!sameFile(lockMetadata, currentLockMetadata) || !sameFile(ownerMetadata, currentOwnerMetadata)) return false;
  try {
    await unlink(ownerPath);
    await rmdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireTabLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const token = randomUUID();
      const ownerPath = resolve(lockPath, `${token}.owner`);
      try {
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw new Error("Could not establish session tab store lock ownership", { cause: error });
      }
      return async () => {
        // A reclaimed lock has already been handed to another owner, so unlink our own marker first and never remove a directory we no longer hold.
        try {
          await unlink(ownerPath);
        } catch (error) {
          throw new Error("Session tab store lock ownership was lost before release", { cause: error });
        }
        try {
          await rmdir(lockPath);
        } catch (error) {
          throw new Error("Could not safely release the session tab store lock", { cause: error });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Could not acquire session tab store lock", { cause: error });
      let metadata;
      try {
        metadata = await lstat(lockPath);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("Could not inspect session tab store lock", { cause: inspectionError });
      }
      if (metadata.isSymbolicLink()) throw new Error("Session tab store lock must not be a symbolic link", { cause: error });
      if (!metadata.isDirectory()) throw new Error("Session tab store lock must be a directory", { cause: error });
      if (await reclaimStaleTabLock(lockPath, metadata)) continue;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for session tab store lock", { cause: error });
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
    // A corrupt or stale store must not fail activation: the harness would otherwise abort entirely over one unusable cache file. Size and type failures still propagate because they signal a containment problem rather than stale content, and mutations keep going through readState so they fail loudly instead of silently discarding tabs.
    let state = await readState(path).catch((error: unknown) => {
      if (error instanceof BoundedFileSizeError || error instanceof BoundedFileTypeError) throw error;
      return emptyState();
    });
    let mutationQueue = Promise.resolve();
    let writes = 0;
    const activeSession = (): { id: string; sessionPath: string } => ({
      id: context.piSession.manager.getSessionId(),
      sessionPath: context.piSession.manager.getSessionFile() ?? join(context.piHarnessLaunch.agentDir, `${context.piSession.manager.getSessionId()}.jsonl`),
    });
    const upsert = (current: TabState, id: string, sessionPath: string, label: string | undefined, pinned: boolean): Tab => {
      const now = new Date().toISOString();
      const existing = current.tabs.find((tab) => tab.sessionPath === sessionPath);
      if (existing !== undefined) {
        existing.label = label?.trim() || existing.label;
        existing.pinned = pinned;
        existing.updatedAt = now;
        current.activeId = existing.id;
        return existing;
      }
      if (current.tabs.length >= maxTabs) throw new Error(`A maximum of ${maxTabs} session tabs is supported`);
      if (current.tabs.some((tab) => tab.id === id)) throw new Error("Session tab id already exists for a different session");
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
            action: Type.Union([
              Type.Literal("pin"),
              Type.Literal("unpin"),
              Type.Literal("rename"),
              Type.Literal("activate"),
              Type.Literal("remove"),
              Type.Literal("list"),
            ]),
            sessionPath: Type.Optional(Type.String()),
            label: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<TabState | Tab>> {
          const active = activeSession();
          const targetPath = params.sessionPath?.trim() || active.sessionPath;
          if (targetPath.length === 0 || targetPath.length > 4_096) throw new Error("Session path must be 1 to 4096 characters");
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
            // Only the active session is keyed by its session id; other sessions are keyed by their file name so the tab describes the requested path.
            const id = targetPath === active.sessionPath ? active.id : basename(targetPath, extname(targetPath)).trim();
            if (id.length === 0 || id.length > 512) throw new Error("Session tab path must name a session file");
            const tab = await mutate((current) => upsert(current, id, targetPath, params.label, true));
            return { content: [{ type: "text", text: `Pinned session tab: ${tab.label}` }], details: tab };
          } else if (params.action === "unpin") {
            await mutate((current) => {
              const target = current.tabs.find((tab) => tab.sessionPath === targetPath);
              if (target === undefined) throw new Error("Session tab not found");
              target.pinned = false;
              target.updatedAt = new Date().toISOString();
              current.activeId = target.id;
            });
          } else throw new Error("session_tab_manage action must be pin, unpin, rename, activate, remove, or list");
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
