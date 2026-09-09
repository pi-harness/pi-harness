import type * as FsPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import tabManagerPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

// Lets one test seize the store lock while a mutation is mid-write, which is the only moment a reclaimed owner can be observed.
const fs = vi.hoisted(() => ({ beforeRename: undefined as (() => Promise<void>) | undefined, lockAttempt: undefined as (() => void) | undefined }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return {
    ...actual,
    default: actual,
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      try {
        return await actual.mkdir(...args);
      } catch (error) {
        if (String(args[0]).endsWith("session-tabs.json.lock") && (error as NodeJS.ErrnoException).code === "EEXIST") fs.lockAttempt?.();
        throw error;
      }
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      const hook = fs.beforeRename;
      fs.beforeRename = undefined;
      if (hook !== undefined) await hook();
      return actual.rename(...args);
    },
  };
});

const contexts: Context[] = [];
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-tabs-"));
  roots.push(root);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piSession", { manager: { getSessionId: () => "session-1", getSessionFile: () => join(root, "session-1.jsonl") } } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(tabManagerPlugin);
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "session_tab_manage");
  if (tool === undefined) throw new Error("session_tab_manage was not registered");
  return { root, context, tools, panels, tool };
}

afterEach(async () => {
  fs.beforeRename = undefined;
  fs.lockAttempt = undefined;
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tab manager", () => {
  test("pins, renames, lists, and removes a session tab", async () => {
    const { tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(tool.execute("pin", { action: "pin", label: "Current" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { id: "session-1", label: "Current", pinned: true },
    });
    await expect(tool.execute("rename", { action: "rename", label: "Renamed" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { selectedId: "session-1", tabs: [{ label: "Renamed", pinned: true }] },
    });
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [{ label: "Renamed" }] },
    });
    await expect(tool.execute("remove", { action: "remove" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [], selectedId: null },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tabs: [], selectedId: null } }]);
  });

  test("pins another session by its requested path without touching the active session's tab", async () => {
    const { root, tool } = await fixture();
    const otherPath = join(root, "session-2.jsonl");
    await expect(
      tool.execute("pin-other", { action: "pin", sessionPath: otherPath, label: "Other" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { id: "session-2", label: "Other", sessionPath: otherPath, pinned: true },
    });
    await expect(tool.execute("pin-active", { action: "pin", label: "Mine" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { id: "session-1", label: "Mine", sessionPath: join(root, "session-1.jsonl"), pinned: true },
    });
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        selectedId: "session-1",
        tabs: [
          { id: "session-1", label: "Mine" },
          { id: "session-2", label: "Other" },
        ],
      },
    });
    await expect(tool.execute("activate", { action: "activate", sessionPath: otherPath }, undefined, undefined, {} as never)).rejects.toThrow(
      /requires the Pi runtime/i,
    );
    await expect(tool.execute("remove", { action: "remove", sessionPath: otherPath }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { selectedId: "session-1", tabs: [{ id: "session-1", label: "Mine" }] },
    });
  });

  test("rejects pinning a second session whose file name collides with an existing tab id", async () => {
    const { root, tool } = await fixture();
    await tool.execute("pin-first", { action: "pin", sessionPath: join(root, "a", "shared.jsonl") }, undefined, undefined, {} as never);
    await expect(
      tool.execute("pin-second", { action: "pin", sessionPath: join(root, "b", "shared.jsonl") }, undefined, undefined, {} as never),
    ).rejects.toThrow(/already exists/iu);
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [{ id: "shared", sessionPath: join(root, "a", "shared.jsonl") }] },
    });
  });

  test("reclaims a stale session tab lock owned by a dead process after restart", async () => {
    const { root, tool } = await fixture();
    const lockPath = join(root, "session-tabs.json.lock");
    const ownerPath = join(lockPath, "abandoned.owner");
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999_999, token: "abandoned" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(ownerPath, old, old);
    await utimes(lockPath, old, old);
    const pending = tool.execute("pin", { action: "pin", label: "Recovered" }, undefined, undefined, {} as never);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending.then(() => "completed"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("waiting"), 500);
        }),
      ]);
      expect(outcome).toBe("completed");
      await expect(pending).resolves.toMatchObject({ details: { label: "Recovered", pinned: true } });
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await rm(lockPath, { recursive: true, force: true });
      await pending.catch(() => undefined);
    }
  });

  test("does not reclaim a stale session tab lock owned by a live process", async () => {
    const { root, tool } = await fixture();
    const lockPath = join(root, "session-tabs.json.lock");
    const ownerPath = join(lockPath, "live.owner");
    const owner = JSON.stringify({ pid: process.pid, token: "live" });
    await mkdir(lockPath);
    await writeFile(ownerPath, owner, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(ownerPath, old, old);
    await utimes(lockPath, old, old);
    const pending = tool.execute("pin", { action: "pin", label: "Blocked" }, undefined, undefined, {} as never);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending.then(() => "completed"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("waiting"), 500);
        }),
      ]);
      expect(outcome).toBe("waiting");
      await expect(readFile(ownerPath, "utf8")).resolves.toBe(owner);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await rm(lockPath, { recursive: true, force: true });
      await pending.catch(() => undefined);
    }
  });

  test("does not delete a session tab lock that another owner reclaimed mid-mutation", async () => {
    const { root, tool } = await fixture();
    const lockPath = join(root, "session-tabs.json.lock");
    const seizedOwnerPath = join(lockPath, "seized.owner");
    const seizedOwner = JSON.stringify({ pid: process.pid, token: "seized" });
    fs.beforeRename = async () => {
      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(seizedOwnerPath, seizedOwner, { encoding: "utf8", mode: 0o600, flag: "wx" });
    };
    await expect(tool.execute("pin", { action: "pin", label: "Racy" }, undefined, undefined, {} as never)).rejects.toThrow(/ownership was lost/iu);
    await expect(readFile(seizedOwnerPath, "utf8")).resolves.toBe(seizedOwner);
    await rm(lockPath, { recursive: true, force: true });
  });

  test("enumerates the supported actions and rejects anything else", async () => {
    const { tool } = await fixture();
    expect(tool.parameters).toMatchObject({
      properties: {
        action: {
          anyOf: [{ const: "pin" }, { const: "unpin" }, { const: "rename" }, { const: "activate" }, { const: "remove" }, { const: "list" }],
        },
      },
    });
    await tool.execute("pin", { action: "pin", label: "Current" }, undefined, undefined, {} as never);
    await expect(tool.execute("close", { action: "close" }, undefined, undefined, {} as never)).rejects.toThrow(/action must be/iu);
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [{ label: "Current", pinned: true }] },
    });
  });

  test("rejects a session path whose file name yields an empty tab id and leaves the store untouched", async () => {
    const { root, tool } = await fixture();
    await tool.execute("pin-active", { action: "pin", label: "Mine" }, undefined, undefined, {} as never);
    const before = await readFile(join(root, "session-tabs.json"), "utf8");
    await expect(tool.execute("pin-root", { action: "pin", sessionPath: "/" }, undefined, undefined, {} as never)).rejects.toThrow(/session file/iu);
    await expect(readFile(join(root, "session-tabs.json"), "utf8")).resolves.toBe(before);
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { selectedId: "session-1", tabs: [{ id: "session-1", label: "Mine" }] },
    });
  });

  test("recovers from a corrupt store at activation instead of failing the plugin fiber", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-tabs-"));
    roots.push(root);
    await writeFile(join(root, "session-tabs.json"), '{"tabs":[{"id":"","label":"","sessionPath":"/","pinned":true,"updatedAt":"nope"}],"selectedId"', "utf8");
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piSession", { manager: { getSessionId: () => "session-1", getSessionFile: () => join(root, "session-1.jsonl") } } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await expect(context.plugin(tabManagerPlugin)).resolves.toBeDefined();
    contexts.push(context);
    const tool = tools.snapshot().customTools.find((item) => item.name === "session_tab_manage");
    if (tool === undefined) throw new Error("session_tab_manage was not registered");
    await expect(tool.execute("pin", { action: "pin", label: "Fresh" }, undefined, undefined, {} as never)).rejects.toThrow(/invalid JSON/iu);
  });

  test("rejects invalid labels and disposes its registry entries", async () => {
    const { context, tool, tools, panels } = await fixture();
    await expect(tool.execute("rename", { action: "rename", label: "" }, undefined, undefined, {} as never)).rejects.toThrow(/label/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});

test("does not write after cancellation or plugin disposal", async () => {
  const { root, context, tool } = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(tool.execute("cancel", { action: "pin" }, abort.signal, undefined, {} as never)).rejects.toThrow(/cancel/i);
  await expect(lstat(join(root, "session-tabs.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await context.fiber.dispose();
  await expect(tool.execute("disposed", { action: "pin" }, undefined, undefined, {} as never)).rejects.toThrow(/cancel/i);
});

test("preserves the active tab when removing a different tab", async () => {
  const { root, tool } = await fixture();
  for (const name of ["one", "two", "three"])
    await tool.execute(name, { action: "pin", sessionPath: join(root, name + ".jsonl") }, undefined, undefined, {} as never);
  await tool.execute("rename", { action: "rename", sessionPath: join(root, "one.jsonl"), label: "Selected" }, undefined, undefined, {} as never);
  const result = await tool.execute("remove", { action: "remove", sessionPath: join(root, "two.jsonl") }, undefined, undefined, {} as never);
  expect(result.details).toMatchObject({ selectedId: "one" });
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.details);
});

test("rejects unknown parameters and oversized raw labels before writing", async () => {
  const { tool } = await fixture();
  await expect(tool.execute("relative", { action: "pin", sessionPath: "relative.jsonl" }, undefined, undefined, {} as never)).rejects.toThrow(/absolute path/i);
  await expect(tool.execute("invalid", { action: "pin", extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/parameter/i);
  await expect(tool.execute("invalid", { action: "pin", label: " ".repeat(121) }, undefined, undefined, {} as never)).rejects.toThrow(/label/i);
});

test("pins the native runtime manager and rejects ephemeral sessions", async () => {
  const { root, context, tool } = await fixture();
  const manager = SessionManager.create(root, join(root, "native-sessions"));
  const runtime = { session: { sessionManager: manager } };
  context.provide("piRuntime", runtime as never);
  const result = await tool.execute("active", { action: "pin" }, undefined, undefined, {} as never);
  expect(result.details).toMatchObject({ id: manager.getSessionId(), sessionPath: manager.getSessionFile() });
  runtime.session.sessionManager = SessionManager.inMemory(root);
  await expect(tool.execute("ephemeral", { action: "pin" }, undefined, undefined, {} as never)).rejects.toThrow(/persistent session path/i);
});

test("cancels while waiting for another process lock without changing its files", async () => {
  const { root, tool } = await fixture();
  const lock = join(root, "session-tabs.json.lock");
  await mkdir(lock);
  const owner = JSON.stringify({ pid: process.pid, token: "live" });
  await writeFile(join(lock, "live.owner"), owner);
  const abort = new AbortController();
  const attempted = new Promise<void>((resolve) => {
    fs.lockAttempt = resolve;
  });
  const pending = tool.execute("waiting", { action: "pin" }, abort.signal, undefined, {} as never);
  const assertion = expect(pending).rejects.toThrow(/cancel/i);
  await attempted;
  abort.abort();
  await assertion;
  expect(await readFile(join(lock, "live.owner"), "utf8")).toBe(owner);
  await expect(lstat(join(root, "session-tabs.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("returns queued activation before idle and only switches once the source settles", async () => {
  const { root, context, tool, panels } = await fixture();
  const target = join(root, "target.jsonl");
  await writeFile(target, JSON.stringify({ type: "session", version: 3, id: "target", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  await tool.execute("pin", { action: "pin", sessionPath: target }, undefined, undefined, {} as never);
  let idle!: () => void;
  const wait = new Promise<void>((resolve) => {
    idle = resolve;
  });
  const source = {
    sessionId: "source",
    sessionFile: join(root, "source.jsonl"),
    sessionManager: SessionManager.create(root, join(root, "sessions")),
    isIdle: false,
    waitForIdle: () => wait,
  };
  const runtime = {
    session: source,
    sessionRuntime: {
      switchSession: vi.fn((path: string) => {
        runtime.session = { ...source, sessionFile: path, sessionManager: SessionManager.open(path) };
        return Promise.resolve({ cancelled: false });
      }),
    },
  };
  context.provide("piRuntime", runtime as never);
  const accepted = await tool.execute("activate", { action: "activate", sessionPath: target }, undefined, undefined, {} as never);
  expect(accepted.details).toMatchObject({ state: "waiting", sessionPath: target });
  expect(runtime.sessionRuntime.switchSession).not.toHaveBeenCalled();
  await expect(tool.execute("duplicate", { action: "activate", sessionPath: target }, undefined, undefined, {} as never)).rejects.toThrow(/already pending/);
  source.isIdle = true;
  idle();
  await vi.waitFor(async () => expect((await panels.snapshot())[0]?.data).toMatchObject({ activation: { state: "completed" }, currentSessionPath: target }));
  expect(runtime.sessionRuntime.switchSession).toHaveBeenCalledTimes(1);
  runtime.session.waitForIdle = () => new Promise<void>(() => {});
  runtime.session.isIdle = false;
  const abort = new AbortController();
  await tool.execute("cancel", { action: "activate", sessionPath: target }, abort.signal, undefined, {} as never);
  abort.abort();
  await vi.waitFor(async () => expect((await panels.snapshot())[0]?.data).toMatchObject({ activation: { state: "cancelled" } }));
  expect(runtime.sessionRuntime.switchSession).toHaveBeenCalledTimes(1);
  runtime.session.waitForIdle = () => Promise.resolve();
  runtime.session.isIdle = true;
  await rm(target);
  await tool.execute("missing", { action: "activate", sessionPath: target }, undefined, undefined, {} as never);
  await vi.waitFor(async () => expect((await panels.snapshot())[0]?.data).toMatchObject({ activation: { state: "failed" } }));
  expect(runtime.sessionRuntime.switchSession).toHaveBeenCalledTimes(1);
});
