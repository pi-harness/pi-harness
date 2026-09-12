import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import memoryPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const roots: string[] = [];

async function fixture(config: { fileName?: string; maxEntries?: number } = { fileName: "memory.json", maxEntries: 5 }) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-memory-"));
  roots.push(root);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("memory", () => {
  test("recalls valid one-character keys and rejects empty queries", async () => {
    const { set, search } = await fixture();
    await set.execute("set", { key: "锈", value: "Rust" }, undefined, undefined, {} as never);
    await expect(search.execute("search", { query: " 锈 " }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { query: "锈", total: 1, memories: [{ key: "锈", value: "Rust" }] },
    });
    await expect(search.execute("empty", { query: "  " }, undefined, undefined, {} as never)).rejects.toThrow(/query/iu);
  });

  test("rejects cancelled and disposed writes without creating a store", async () => {
    const { root, context, set } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("Memory request cancelled"));
    await expect(set.execute("cancel", { key: "cancel", value: "never written" }, controller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    await context.fiber.dispose();
    await expect(set.execute("disposed", { key: "disposed", value: "never written" }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    await expect(lstat(join(root, "memory.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps returned search details separate from the stored panel report", async () => {
    const { set, search, panels } = await fixture();
    await set.execute("set", { key: "language", value: "TypeScript", tags: ["code"] }, undefined, undefined, {} as never);
    const result = await search.execute("search", { query: "script" }, undefined, undefined, {} as never);
    const report = result.details as { query: string; memories: Array<{ value: string; tags: string[] }> };
    report.query = "changed";
    report.memories[0]!.value = "changed";
    report.memories[0]!.tags.push("changed");
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: { query: "script", memories: [{ value: "TypeScript", tags: ["code"] }] } } }]);
  });

  test("bounds recent and last-search panel inventories with explicit counts", async () => {
    const { set, search, panels } = await fixture({ fileName: "memory.json", maxEntries: 20 });
    for (let index = 1; index <= 12; index += 1) {
      await set.execute("set", { key: `tenant-${index}`, value: `shared operations fact ${index}`, tags: ["operations"] }, undefined, undefined, {} as never);
    }
    await search.execute("search", { query: "operations" }, undefined, undefined, {} as never);

    await expect(panels.snapshot()).resolves.toMatchObject([
      {
        data: {
          count: 12,
          shown: 8,
          truncated: true,
          memories: Array.from({ length: 8 }, (_, index) => ({ key: `tenant-${12 - index}` })),
          last: { query: "operations", total: 12, shown: 8, truncated: true },
        },
      },
    ]);
    const data = (await panels.snapshot())[0]?.data as { last: { memories: unknown[] } };
    expect(data.last.memories).toHaveLength(8);
  });

  test("paginates broad searches with honest continuation metadata", async () => {
    const { set, search } = await fixture({ fileName: "memory.json", maxEntries: 20 });
    for (let index = 1; index <= 12; index += 1) {
      await set.execute("set", { key: `tenant-${index}`, value: `shared fact ${index}` }, undefined, undefined, {} as never);
    }

    const first = (await search.execute("first", { query: "tenant" }, undefined, undefined, {} as never)).details as {
      total: number;
      offset: number;
      shown: number;
      truncated: boolean;
      nextOffset: number | null;
      memories: Array<{ key: string }>;
    };
    expect(first).toMatchObject({ total: 12, offset: 0, shown: 8, truncated: true, nextOffset: 8 });
    expect(first.memories.map((item) => item.key)).toEqual(Array.from({ length: 8 }, (_, index) => `tenant-${12 - index}`));

    const second = (await search.execute("second", { query: "tenant", offset: first.nextOffset, limit: 8 }, undefined, undefined, {} as never)).details as {
      total: number;
      offset: number;
      shown: number;
      truncated: boolean;
      nextOffset: number | null;
      memories: Array<{ key: string }>;
    };
    expect(second).toMatchObject({ total: 12, offset: 8, shown: 4, truncated: false, nextOffset: null });
    expect(second.memories.map((item) => item.key)).toEqual(["tenant-4", "tenant-3", "tenant-2", "tenant-1"]);
  });

  test("leaves the latest successful panel search unchanged after invalid pagination", async () => {
    const { set, search, panels } = await fixture();
    await set.execute("keep", { key: "keep", value: "visible" }, undefined, undefined, {} as never);
    await set.execute("secret", { key: "secret", value: "must not replace panel state" }, undefined, undefined, {} as never);
    await search.execute("successful", { query: "keep" }, undefined, undefined, {} as never);

    await expect(search.execute("invalid", { query: "secret", offset: -1 }, undefined, undefined, {} as never)).rejects.toThrow(/offset/iu);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: { query: "keep", total: 1, memories: [{ key: "keep" }] } } }]);
  });

  test("bounds and annotates large values in model-visible search pages", async () => {
    const { set, search } = await fixture();
    const value = "\0".repeat(64 * 1024);
    for (let index = 1; index <= 3; index += 1) {
      await set.execute("set", { key: `tenant-${index}`, value }, undefined, undefined, {} as never);
    }

    const result = await search.execute("large", { query: "tenant", limit: 8 }, undefined, undefined, {} as never);
    const details = result.details as {
      total: number;
      shown: number;
      truncated: boolean;
      nextOffset: number | null;
      memories: Array<{ value: string; valueBytes: number; valueTruncated: boolean }>;
    };
    expect(details.total).toBe(3);
    expect(details.shown).toBeGreaterThan(0);
    expect(details.shown).toBeLessThan(3);
    expect(details.truncated).toBe(true);
    expect(details.nextOffset).toBe(details.shown);
    expect(details.memories.every((item) => item.valueTruncated && item.valueBytes === 64 * 1024)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(128 * 1024);
    const content = result.content[0];
    expect(content?.type).toBe("text");
    expect(Buffer.byteLength(content?.type === "text" ? content.text : "", "utf8")).toBeLessThanOrEqual(128 * 1024);
  });

  test("rejects oversized values before UTF-8 byte allocation", async () => {
    const { set } = await fixture();
    const byteLength = vi.spyOn(Buffer, "byteLength");

    await expect(set.execute("oversized", { key: "tenant", value: "x".repeat(64 * 1024 + 1) }, undefined, undefined, {} as never)).rejects.toThrow(
      /at most 65536 bytes/iu,
    );
    expect(byteLength).not.toHaveBeenCalled();
  });

  test("keeps updated memories valid when the wall clock moves backward", async () => {
    const { set, search } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-12T03:00:00.000Z"));
    const created = (await set.execute("create", { key: "tenant", value: "first" }, undefined, undefined, {} as never)).details as { updatedAt: string };
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    const updated = (await set.execute("update", { key: "tenant", value: "second" }, undefined, undefined, {} as never)).details as { updatedAt: string };

    expect(Date.parse(updated.updatedAt)).toBe(Date.parse(created.updatedAt) + 1);
    await expect(search.execute("search", { query: "tenant" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { memories: [{ value: "second" }] },
    });
  });

  test("times out a live lock wait when the wall clock moves backward", async () => {
    const { root, set } = await fixture();
    const lock = join(root, "memory.json.lock");
    await mkdir(lock);
    await writeFile(join(lock, "live.owner"), JSON.stringify({ pid: process.pid }));
    vi.spyOn(Date, "now").mockReturnValue(0);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(10_001);
    const controller = new AbortController();
    const pending = set.execute("frozen-clock", { key: "tenant", value: "never written" }, controller.signal, undefined, {} as never);
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      abortTimer = setTimeout(() => controller.abort(new Error("test fallback cancellation")), 250);
      await expect(pending).rejects.toThrow(/timed out waiting for memory file lock/iu);
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      controller.abort();
      await pending.catch(() => undefined);
      await rm(lock, { recursive: true, force: true });
    }
  });

  test("reads its own maximum-sized escaped JSON value", async () => {
    const { set, search, panels } = await fixture({ maxEntries: 1 });
    const value = "x" + "\u0000".repeat(64 * 1024 - 1);
    await set.execute("escaped", { key: "escaped", value }, undefined, undefined, {} as never);
    await expect(search.execute("search", { query: "escaped" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { memories: [{ valueBytes: 64 * 1024, shownValueBytes: 8 * 1024, valueTruncated: true }] },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { memories: [{ value }] } }]);
  });

  test("reports every eviction after reducing the configured capacity", async () => {
    const { root, set } = await fixture({ maxEntries: 2 });
    const now = new Date().toISOString();
    const stored = Array.from({ length: 5 }, (_, i) => ({ id: `id-${i}`, key: `key-${i}`, value: `value-${i}`, tags: [], createdAt: now, updatedAt: now }));
    await writeFile(join(root, "memory.json"), JSON.stringify({ version: 1, memories: stored }));
    await expect(set.execute("set", { key: "fresh", value: "new" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ text: "Memory saved: fresh (evicted key-1, key-2, key-3, key-4 to stay within 2 entries)" }],
    });
  });

  test("cancels lock waiters and queued writes without disturbing another owner", async () => {
    const { root, set } = await fixture();
    const lock = join(root, "memory.json.lock");
    await mkdir(lock);
    await writeFile(join(lock, "live.owner"), JSON.stringify({ pid: process.pid }));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = set.execute("first", { key: "first", value: "cancelled" }, firstController.signal, undefined, {} as never);
    const second = set.execute("second", { key: "second", value: "cancelled" }, secondController.signal, undefined, {} as never);
    const secondRejected = expect(second).rejects.toThrow(/cancelled/iu);
    secondController.abort(new Error("Queued write cancelled"));
    try {
      await secondRejected;
      const firstRejected = expect(first).rejects.toThrow(/cancelled/iu);
      firstController.abort(new Error("Lock waiter cancelled"));
      await firstRejected;
      expect(JSON.parse(await readFile(join(lock, "live.owner"), "utf8"))).toEqual({ pid: process.pid });
      await expect(lstat(join(root, "memory.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      firstController.abort();
      secondController.abort();
      await Promise.allSettled([first, second]);
      await rm(lock, { recursive: true, force: true });
    }
    await expect(set.execute("after", { key: "after", value: "works" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "after" },
    });
    const persisted = JSON.parse(await readFile(join(root, "memory.json"), "utf8")) as { memories: Array<{ key: string }> };
    expect(persisted.memories.map((item) => item.key)).toEqual(["after"]);
  });

  test("deletes a hidden record without dropping unrelated records after a capacity reduction", async () => {
    const { root, remove } = await fixture({ maxEntries: 1 });
    const now = new Date().toISOString();
    const stored = Array.from({ length: 3 }, (_, i) => ({ id: `id-${i}`, key: `key-${i}`, value: `value-${i}`, tags: [], createdAt: now, updatedAt: now }));
    await writeFile(join(root, "memory.json"), JSON.stringify({ version: 1, memories: stored }));
    await expect(remove.execute("delete", { key: "key-2", confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { removed: true },
    });
    const persisted = JSON.parse(await readFile(join(root, "memory.json"), "utf8")) as { memories: Array<{ key: string }> };
    expect(persisted.memories.map((item) => item.key)).toEqual(["key-0", "key-1"]);
  });

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

  test("rejects extra fields and timestamps that move backward in persisted records", async () => {
    const { root, search } = await fixture();
    const base = {
      id: "id-1",
      key: "tenant",
      value: "fact",
      tags: [],
      createdAt: "2026-09-12T03:00:01.000Z",
      updatedAt: "2026-09-12T03:00:00.000Z",
    };
    for (const memory of [base, { ...base, updatedAt: base.createdAt, extra: true }]) {
      await writeFile(join(root, "memory.json"), JSON.stringify({ version: 1, memories: [memory] }));
      await expect(search.execute("search", { query: "tenant" }, undefined, undefined, {} as never)).rejects.toThrow(/invalid memories/iu);
    }
  });

  test("rejects persisted memories that are not ordered newest first", async () => {
    const { root, search } = await fixture({ maxEntries: 1 });
    const memory = (id: string, updatedAt: string) => ({
      id,
      key: `tenant-${id}`,
      value: `fact-${id}`,
      tags: [],
      createdAt: "2026-09-12T03:00:00.000Z",
      updatedAt,
    });
    await writeFile(
      join(root, "memory.json"),
      JSON.stringify({ version: 1, memories: [memory("older", "2026-09-12T03:00:01.000Z"), memory("newer", "2026-09-12T03:00:02.000Z")] }),
    );

    await expect(search.execute("search", { query: "tenant" }, undefined, undefined, {} as never)).rejects.toThrow(/invalid memories/iu);
  });
});
