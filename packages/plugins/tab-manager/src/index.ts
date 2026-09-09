import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { BoundedFileSizeError, BoundedFileTypeError, EmptyConfig, readBoundedTextFile } from "@pi-harness/plugin-api";

const storageFile = "session-tabs.json";
const maxTabs = 24;
const maxStateFileBytes = 1024 * 1024;
const lockRetryMs = 25;
const lockTimeoutMs = 10_000;
const staleLockMs = 30_000;
const maxLockOwnerBytes = 1024;
type Tab = { id: string; label: string; sessionPath: string; pinned: boolean; updatedAt: string };
type Activation = { requestId: string; sessionPath: string; state: "waiting" | "switching" | "completed" | "cancelled" | "failed"; error?: string };
type TabState = { tabs: Tab[]; selectedId: string | null };

function emptyState(): TabState {
  return { tabs: [], selectedId: null };
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
  const value = parsed as { tabs?: unknown; selectedId?: unknown };
  if (!Array.isArray(value.tabs) || (value.selectedId !== null && typeof value.selectedId !== "string"))
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
      !isAbsolute(tab.sessionPath) ||
      tab.sessionPath !== resolve(tab.sessionPath) ||
      typeof tab.pinned !== "boolean" ||
      typeof tab.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(tab.updatedAt))
    )
      throw new Error("Session tab store contains invalid tabs");
    tabs.push(tab as Tab);
  }
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length || new Set(tabs.map((tab) => tab.sessionPath)).size !== tabs.length)
    throw new Error("Session tab store contains duplicate tabs");
  if (typeof value.selectedId === "string" && !tabs.some((tab) => tab.id === value.selectedId))
    throw new Error("Session tab store contains an invalid active tab");
  return { tabs, selectedId: value.selectedId };
}

async function persist(path: string, state: TabState, check: () => void): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    check();
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

async function acquireTabLock(lockPath: string, check: () => void): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    check();
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
    let activation: Activation | undefined;
    const checkActivationAvailable = () => {
      if (activation?.state === "waiting" || activation?.state === "switching") throw new Error("A session activation is already pending");
    };
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const currentManager = () => context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager;
    const activeSession = (): { id: string; sessionPath: string } => {
      const manager = currentManager();
      const sessionPath = manager.getSessionFile();
      if (sessionPath === undefined) throw new Error("The current session has no persistent session path");
      return { id: manager.getSessionId(), sessionPath };
    };
    const upsert = (current: TabState, id: string, sessionPath: string, label: string | undefined, pinned: boolean): Tab => {
      const now = new Date().toISOString();
      const existing = current.tabs.find((tab) => tab.sessionPath === sessionPath);
      if (existing !== undefined) {
        existing.label = label?.trim() || existing.label;
        existing.pinned = pinned;
        existing.updatedAt = now;
        current.selectedId = existing.id;
        return existing;
      }
      if (current.tabs.length >= maxTabs) throw new Error(`A maximum of ${maxTabs} session tabs is supported`);
      if (current.tabs.some((tab) => tab.id === id)) throw new Error("Session tab id already exists for a different session");
      let defaultLabel = id.slice(0, 120);
      if (/[\uD800-\uDBFF]$/u.test(defaultLabel)) defaultLabel = defaultLabel.slice(0, -1);
      const tab = { id, label: label?.trim() || defaultLabel, sessionPath, pinned, updatedAt: now };
      current.tabs = [tab, ...current.tabs];
      current.selectedId = tab.id;
      return tab;
    };
    const mutate = async <T>(check: () => void, operation: (current: TabState) => T): Promise<T> => {
      let result: T | undefined;
      const run = async (): Promise<void> => {
        check();
        const release = await acquireTabLock(`${path}.lock`, check);
        try {
          const current = await readState(path);
          check();
          result = operation(current);
          await persist(path, current, check);
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
        description:
          "Pin, rename, remove, or list session tabs. Activation queues a real session switch after the current turn becomes idle; inspect the panel for completion.",
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
            sessionPath: Type.Optional(Type.String({ description: "Absolute native session file path", minLength: 1, maxLength: 4096 })),
            label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, input, signal): Promise<AgentToolResult<TabState | Tab | Activation>> {
          const check = () => {
            if (signal?.aborted || lifecycle.signal.aborted) throw new Error("Session tab operation was cancelled");
          };
          check();
          if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Session tab parameters must be an object");
          const descriptors = Object.getOwnPropertyDescriptors(input);
          if (
            Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !["action", "sessionPath", "label"].includes(key)) ||
            Object.values(descriptors).some((entry) => !("value" in entry))
          )
            throw new Error("Invalid session tab parameters");
          const params = input;
          if (typeof params.action !== "string" || !["pin", "unpin", "rename", "activate", "remove", "list"].includes(params.action))
            throw new Error("session_tab_manage action must be pin, unpin, rename, activate, remove, or list");
          if (
            params.label !== undefined &&
            (typeof params.label !== "string" || params.label.length > 120 || params.label.trim() === "" || params.label.includes("\0"))
          )
            throw new Error("Tab label must be 1 to 120 characters");
          if (
            params.sessionPath !== undefined &&
            (typeof params.sessionPath !== "string" ||
              params.sessionPath.length > 4096 ||
              params.sessionPath.trim() === "" ||
              params.sessionPath.includes("\0") ||
              !isAbsolute(params.sessionPath))
          )
            throw new Error("Session path must be an absolute path of 1 to 4096 characters");
          if (params.action === "list" && (params.sessionPath !== undefined || params.label !== undefined))
            throw new Error("List parameters cannot include a session path or label");
          if (!["pin", "rename"].includes(params.action) && params.label !== undefined) throw new Error("Label parameter is only supported by pin and rename");
          if (params.action === "list") {
            const next = await readState(path);
            check();
            state = next;
            const report = {
              ...next,
              currentSessionPath: currentManager().getSessionFile() ?? null,
              activation: activation === undefined ? null : { ...activation },
            };
            return { content: [{ type: "text", text: JSON.stringify(report) }], details: structuredClone(report) };
          }
          const active = params.sessionPath === undefined ? activeSession() : undefined;
          const targetPath = resolve(params.sessionPath ?? active!.sessionPath);
          const manager = currentManager();
          const sessionId = manager.getSessionId();
          const sessionFile = manager.getSessionFile();
          const checkContext = () => {
            check();
            if (active !== undefined && (currentManager() !== manager || manager.getSessionId() !== sessionId || manager.getSessionFile() !== sessionFile))
              throw new Error("Session tab context changed during execution");
          };
          if (params.action === "activate") {
            const runtime = context.get("piRuntime");
            if (runtime === undefined) throw new Error("Session activation requires the Pi runtime");
            checkActivationAvailable();
            const source = runtime.session;
            const sourceId = source.sessionId;
            const current = await readState(path);
            check();
            if (!current.tabs.some((tab) => tab.sessionPath === targetPath)) throw new Error("Session tab not found");
            checkActivationAvailable();
            const request: Activation = { requestId: randomUUID(), sessionPath: targetPath, state: "waiting" };
            activation = request;
            const combined = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            const run = async () => {
              let onAbort: (() => void) | undefined;
              try {
                await Promise.race([
                  source.waitForIdle(),
                  new Promise<never>((_resolve, reject) => {
                    onAbort = () => reject(new Error("Session activation was cancelled"));
                    combined.addEventListener("abort", onAbort, { once: true });
                    if (combined.aborted) onAbort();
                  }),
                ]);
                check();
                if (context.get("piRuntime") !== runtime || runtime.session !== source || source.sessionId !== sourceId || !source.isIdle)
                  throw new Error("Session context changed before activation");
                const latest = await readState(path);
                if (!latest.tabs.some((tab) => tab.sessionPath === targetPath)) throw new Error("Session tab was removed before activation");
                const text = await readBoundedTextFile(targetPath, 4 * 1024 * 1024, "Session activation file");
                const header = JSON.parse(text.split("\n", 1)[0] ?? "") as Record<string, unknown>;
                if (header.type !== "session" || header.version !== 3 || typeof header.id !== "string" || typeof header.cwd !== "string")
                  throw new Error("Session activation requires a native Pi session file");
                check();
                if (context.get("piRuntime") !== runtime || runtime.session !== source || source.sessionId !== sourceId || !source.isIdle)
                  throw new Error("Session context changed before activation");
                request.state = "switching";
                const outcome = await runtime.sessionRuntime.switchSession(targetPath);
                if (outcome.cancelled) {
                  request.state = "cancelled";
                  return;
                }
                if (runtime.session.sessionFile !== targetPath) throw new Error("Pi runtime did not activate the requested session");
                request.state = "completed";
              } catch (error) {
                request.state = combined.aborted ? "cancelled" : "failed";
                request.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
              } finally {
                if (onAbort !== undefined) combined.removeEventListener("abort", onAbort);
              }
            };
            void run();
            const accepted = { ...request };
            return { content: [{ type: "text", text: JSON.stringify(accepted) }], details: accepted };
          }
          if (params.action === "remove") {
            await mutate(checkContext, (current) => {
              const target = current.tabs.find((tab) => tab.sessionPath === targetPath);
              if (target === undefined) throw new Error("Session tab not found");
              current.tabs = current.tabs.filter((tab) => tab !== target);
              if (current.selectedId === target.id) current.selectedId = current.tabs[0]?.id ?? null;
            });
          } else if (params.action === "rename") {
            const label = params.label?.trim() ?? "";
            if (label.length === 0 || label.length > 120) throw new Error("Tab label must be 1 to 120 characters");
            await mutate(checkContext, (current) => {
              const target = current.tabs.find((tab) => tab.sessionPath === targetPath);
              if (target === undefined) throw new Error("Session tab not found");
              target.label = label;
              target.updatedAt = new Date().toISOString();
              current.selectedId = target.id;
            });
          } else if (params.action === "pin") {
            // Only the active session is keyed by its session id; other sessions are keyed by their file name so the tab describes the requested path.
            const id = active !== undefined ? active.id : basename(targetPath, extname(targetPath)).trim();
            if (id.length === 0 || id.length > 512) throw new Error("Session tab path must name a session file");
            const tab = await mutate(checkContext, (current) => upsert(current, id, targetPath, params.label, true));
            return { content: [{ type: "text", text: JSON.stringify(tab) }], details: structuredClone(tab) };
          } else if (params.action === "unpin") {
            await mutate(checkContext, (current) => {
              const target = current.tabs.find((tab) => tab.sessionPath === targetPath);
              if (target === undefined) throw new Error("Session tab not found");
              target.pinned = false;
              target.updatedAt = new Date().toISOString();
              current.selectedId = target.id;
            });
          } else throw new Error("session_tab_manage action must be pin, unpin, rename, activate, remove, or list");
          return { content: [{ type: "text", text: JSON.stringify(state) }], details: structuredClone(state) };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "tab-manager-panel",
        pluginId: "@pi-harness/plugin-tab-manager",
        title: "Session Tabs",
        description: "管理命名会话标签；移除标签不会删除会话文件。",
        icon: "▣",
        read: async () => {
          state = await readState(path);
          return {
            selectedId: state.selectedId,
            tabs: state.tabs,
            currentSessionPath: currentManager().getSessionFile() ?? null,
            activation: activation === undefined ? null : { ...activation },
            writes,
          };
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
