import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import memoryPlugin from "../src/plugins/memory.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

async function fixture(config: { fileName?: string; maxEntries?: number } = { fileName: "memory.json", maxEntries: 5 }) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-memory-"));
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(memoryPlugin, config);
  contexts.push(context);
  const find = (name: string) => {
    const tool = tools.snapshot().customTools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return { root, context, tools, panels, set: find("memory_set"), search: find("memory_search"), remove: find("memory_delete") };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("memory", () => {
  test("falls back to a finite entry limit for non-finite configuration", async () => {
    const { set } = await fixture({ fileName: "memory.json", maxEntries: Number.NaN });

    await expect(set.execute("finite-limit", { key: "safe", value: "bounded" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "safe", value: "bounded" },
    });
  });

  test("reclaims a stale memory lock owned by a dead process after restart", async () => {
    const { root, set } = await fixture();
    const lockPath = join(root, "memory.json.lock");
    const ownerPath = join(lockPath, "abandoned.owner");
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999_999, token: "abandoned" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(ownerPath, old, old);
    await utimes(lockPath, old, old);
    const pending = set.execute("restart", { key: "restart", value: "recovered" }, undefined, undefined, {} as never);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending.then(() => "completed"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("waiting"), 500);
        }),
      ]);
      expect(outcome).toBe("completed");
      await expect(pending).resolves.toMatchObject({ details: { key: "restart", value: "recovered" } });
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await rm(lockPath, { recursive: true, force: true });
      await pending.catch(() => undefined);
    }
  });

  test("does not reclaim a stale memory lock owned by a live process", async () => {
    const { root, set } = await fixture();
    const lockPath = join(root, "memory.json.lock");
    const ownerPath = join(lockPath, "live.owner");
    const owner = JSON.stringify({ pid: process.pid, token: "live" });
    await mkdir(lockPath);
    await writeFile(ownerPath, owner, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(ownerPath, old, old);
    await utimes(lockPath, old, old);
    const pending = set.execute("live-lock", { key: "live", value: "must wait" }, undefined, undefined, {} as never);
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

  test("persists, searches, and confirms deletion of explicit facts", async () => {
    const { set, search, remove, panels } = await fixture();
    for (const tool of [set, search, remove]) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    await expect(set.execute("set", { key: "language", value: "TypeScript", tags: ["code"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "language", value: "TypeScript", tags: ["code"] },
    });
    await expect(search.execute("search", { query: "script" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 1 } });
    await expect(remove.execute("delete", { key: "language", confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await expect(remove.execute("delete", { key: "language", confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "language", removed: true },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { count: 0 } }]);
  });

  test("reports the least recently written memory dropped at the entry limit", async () => {
    const { set, search, panels } = await fixture({ fileName: "memory.json", maxEntries: 2 });
    await set.execute("first", { key: "alpha", value: "one" }, undefined, undefined, {} as never);
    await set.execute("second", { key: "beta", value: "two" }, undefined, undefined, {} as never);

    await expect(set.execute("third", { key: "gamma", value: "three" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ type: "text", text: "Memory saved: gamma (evicted alpha to stay within 2 entries)" }],
      details: { key: "gamma", value: "three" },
    });
    await expect(search.execute("search", { query: "one" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 0 } });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { count: 2 } }]);
  });

  test("still accepts writes when the stored file holds more entries than the configured limit", async () => {
    const { root, set, search } = await fixture({ fileName: "memory.json", maxEntries: 2 });
    const now = new Date().toISOString();
    const stored = Array.from({ length: 5 }, (_, index) => ({
      id: `id-${index}`,
      key: `key-${index}`,
      value: `value-${index}`,
      tags: [],
      createdAt: now,
      updatedAt: now,
    }));
    await writeFile(join(root, "memory.json"), JSON.stringify({ version: 1, memories: stored }), "utf8");

    await expect(search.execute("search", { query: "value" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 2 } });
    await expect(set.execute("set", { key: "fresh", value: "written" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "fresh", value: "written" },
    });

    const persisted = JSON.parse(await readFile(join(root, "memory.json"), "utf8")) as { memories: Array<{ key: string }> };
    expect(persisted.memories.map((memory) => memory.key)).toEqual(["fresh", "key-0"]);
  });

  test("fails closed on malformed persisted records and cleans up", async () => {
    const { root, context, tools, panels } = await fixture();
    await writeFile(join(root, "memory.json"), JSON.stringify({ version: 1, memories: [{ id: "x", key: "x", value: "ok", tags: [] }] }));
    const search = tools.snapshot().customTools.find((item) => item.name === "memory_search");
    if (search === undefined) throw new Error("memory_search was not registered");
    await expect(search.execute("search", { query: "ok" }, undefined, undefined, {} as never)).rejects.toThrow(/invalid memories/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
