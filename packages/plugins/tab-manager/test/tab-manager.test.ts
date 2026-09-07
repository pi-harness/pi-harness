import type * as FsPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import tabManagerPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

// Lets one test seize the store lock while a mutation is mid-write, which is the only moment a reclaimed owner can be observed.
const fs = vi.hoisted(() => ({ beforeRename: undefined as (() => Promise<void>) | undefined }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return {
    ...actual,
    default: actual,
    async rename(...args: Parameters<typeof actual.rename>) {
      const hook = fs.beforeRename;
      fs.beforeRename = undefined;
      if (hook !== undefined) await hook();
      return actual.rename(...args);
    },
  };
});

const contexts: Context[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-tabs-"));
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
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
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
      details: { activeId: "session-1", tabs: [{ label: "Renamed", pinned: true }] },
    });
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [{ label: "Renamed" }] },
    });
    await expect(tool.execute("remove", { action: "remove" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [], activeId: null },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tabs: [], activeId: null } }]);
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
        activeId: "session-1",
        tabs: [
          { id: "session-1", label: "Mine" },
          { id: "session-2", label: "Other" },
        ],
      },
    });
    await expect(tool.execute("activate", { action: "activate", sessionPath: otherPath }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ type: "text", text: "Active session tab: Other" }],
      details: { activeId: "session-2" },
    });
    await expect(tool.execute("remove", { action: "remove", sessionPath: otherPath }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { activeId: "session-1", tabs: [{ id: "session-1", label: "Mine" }] },
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
      details: { activeId: "session-1", tabs: [{ id: "session-1", label: "Mine" }] },
    });
  });

  test("recovers from a corrupt store at activation instead of failing the plugin fiber", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-tabs-"));
    await writeFile(join(root, "session-tabs.json"), '{"tabs":[{"id":"","label":"","sessionPath":"/","pinned":true,"updatedAt":"nope"}],"activeId"', "utf8");
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
