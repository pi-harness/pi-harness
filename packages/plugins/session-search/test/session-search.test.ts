import { mkdtemp, opendir, readFile, writeFile, truncate, symlink, rm } from "node:fs/promises";
import { Dir } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { afterEach, describe, expect, test, vi } from "vitest";
import plugin, { searchSessionEntries, type SessionSearchReport } from "../src/index.js";

describe("session search", () => {
  test("returns matching message previews with session context", () => {
    const result = searchSessionEntries(
      [
        { type: "message", message: { role: "user", content: "fix the auth flow" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will inspect auth.ts" }] } },
        { type: "message", message: { role: "user", content: "unrelated" } },
      ],
      "auth",
    );
    expect(result.hits).toEqual([
      { role: "user", text: "fix the auth flow" },
      { role: "assistant", text: "I will inspect auth.ts" },
    ]);
  });

  test("rejects empty or overlong queries", () => {
    expect(() => searchSessionEntries([], "")).toThrow("Session search query must contain 1-120 characters");
    expect(() => searchSessionEntries([], "x".repeat(121))).toThrow("Session search query must contain 1-120 characters");
  });

  test("applies the query limit before Unicode lowercase expansion", () => {
    const query = "İ".repeat(120);
    const result = searchSessionEntries([{ type: "message", message: { role: "user", content: query } }], query);
    expect(result).toEqual({ total: 1, hits: [{ role: "user", text: query }] });
    expect(() => searchSessionEntries([], query + "İ")).toThrow(/1-120/);
  });

  test("centers long previews around the matching text", () => {
    const result = searchSessionEntries([{ type: "message", message: { role: "user", content: `${"x".repeat(700)}needle${"y".repeat(700)}` } }], "needle");
    expect(result.hits[0]?.text).toContain("needle");
    expect(result.hits[0]?.text).toHaveLength(500);
  });
  test("does not split emoji at long preview boundaries", () => {
    const result = searchSessionEntries([{ type: "message", message: { role: "user", content: `${"😀".repeat(350)}needle${"😀".repeat(350)}` } }], "needle");
    const preview = result.hits[0]!.text;
    expect(preview).toContain("needle");
    expect(preview.length).toBeLessThanOrEqual(500);
    expect(Buffer.from(preview, "utf8").toString("utf8")).toBe(preview);
  });
  test("excludes tool output and limits matching previews", () => {
    const entries = [
      { type: "message", message: { role: "toolResult", content: "needle secret tool output" } },
      ...Array.from({ length: 30 }, () => ({ type: "message", message: { role: "user", content: "needle" } })),
    ];
    expect(searchSessionEntries(entries, "needle")).toEqual({ total: 30, hits: Array.from({ length: 10 }, () => ({ role: "user", text: "needle" })) });
  });
});

const contexts: Context[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-session-search-"));
  directories.push(cwd);
  const directory = join(cwd, "sessions");
  const manager = SessionManager.create(cwd, directory);
  manager.appendMessage({ role: "user", content: "needle 原生会话", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "needle found" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd: "/stale-launch", agentDir: cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager: SessionManager.inMemory("/stale-manager") } as never);
  context.provide("piRuntime", { session: { sessionManager: manager } } as never);
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(plugin);
  const tool = tools.snapshot().customTools.find((item) => item.name === "session_search")!;
  const search = async (query = "needle", signal?: AbortSignal): Promise<AgentToolResult<SessionSearchReport>> =>
    (await tool.execute("search", { query }, signal, undefined, {} as never)) as AgentToolResult<SessionSearchReport>;
  return { cwd, directory, manager, context, panels, tool, search };
}

test("searches real active-workspace journals and reports skipped files without modifying them", async () => {
  const { cwd, directory, manager, panels, search } = await fixture();
  const original = await readFile(manager.getSessionFile()!);
  await writeFile(join(directory, "broken.jsonl"), Buffer.concat([original, Buffer.from("{broken\n")]));
  await writeFile(join(directory, "invalid-utf8.jsonl"), Buffer.from([255, 254]));
  await symlink(manager.getSessionFile()!, join(directory, "link.jsonl"));
  await writeFile(join(directory, "foreign.jsonl"), original.toString().replaceAll(cwd, "/foreign"));
  const result = await search();
  expect(result.details).toMatchObject({ total: 1, cwd, scanned: 1, skipped: 4, items: [{ id: manager.getSessionId(), totalHits: 2 }] });
  expect(JSON.stringify(result.content)).toContain("needle 原生会话");
  expect(await readFile(manager.getSessionFile()!)).toEqual(original);
  result.details.items[0]!.name = "MUTATED";
  expect(JSON.stringify(await panels.snapshot())).not.toContain("MUTATED");
});

test("searches a valid Unicode query in a real journal without rejecting expanded lowercase text", async () => {
  const { manager, search } = await fixture();
  const query = "İ".repeat(120);
  const file = manager.getSessionFile()!;
  const contents = (await readFile(file, "utf8")).replaceAll("needle", query);
  await writeFile(file, contents);
  const report = (await search(query)).details;
  expect(report).toMatchObject({ query, total: 1, scanned: 1, nextCursor: null, items: [{ totalHits: 2 }] });
  expect(report.items[0]!.hits.every((hit) => hit.text.includes(query))).toBe(true);
  expect(await readFile(file, "utf8")).toBe(contents);
});

test("rejects cancellation, session changes, disposal and malformed parameters before publishing", async () => {
  const { manager, context, panels, tool, search } = await fixture();
  await search();
  const abort = new AbortController();
  const cancelled = search("cancelled", abort.signal);
  abort.abort();
  await expect(cancelled).rejects.toThrow(/cancelled/);
  const changed = search("changed");
  manager.newSession();
  await expect(changed).rejects.toThrow(/context changed/);
  expect((await panels.snapshot())[0]!.data).toMatchObject({ query: "", total: 0, items: [] });
  for (const params of [
    null,
    {},
    { query: 1 },
    { query: "x", extra: true },
    { query: "\0" },
    {
      get query() {
        throw new Error("GETTER EXECUTED");
      },
    },
  ]) {
    await expect(tool.execute("invalid", params as never, undefined, undefined, {} as never)).rejects.not.toThrow("GETTER EXECUTED");
  }
  const disposed = search();
  await context.fiber.dispose();
  await expect(disposed).rejects.toThrow(/cancelled/);
  await expect(search()).rejects.toThrow(/cancelled/);
});

test("bounds candidate and result counts independently and keeps full matching-message totals", async () => {
  const { directory, manager, search, tool } = await fixture();
  const original = await readFile(manager.getSessionFile()!, "utf8");
  for (let index = 0; index < 205; index += 1)
    await writeFile(join(directory, `copy-${index}.jsonl`), original.replaceAll(manager.getSessionId(), `copy-${index}`));
  const result = await search();
  expect(result.details).toMatchObject({ scanned: 100, skipped: 0, total: 100, truncated: true });
  expect(result.details.items).toHaveLength(100);
  expect(result.details.items.every((item) => item.totalHits === 2)).toBe(true);
  const paths = result.details.items.map((item) => item.path);
  let cursor = (result.details as SessionSearchReport & { nextCursor: string | null }).nextCursor;
  for (let page = 0; cursor !== null && page < 5; page += 1) {
    const next = (await tool.execute("next", { query: "needle", cursor }, undefined, undefined, {} as never)) as AgentToolResult<
      SessionSearchReport & { nextCursor: string | null }
    >;
    expect(next.details.items.length).toBeLessThanOrEqual(100);
    expect(next.details.items.every((item) => item.totalHits === 2)).toBe(true);
    paths.push(...next.details.items.map((item) => item.path));
    cursor = next.details.nextCursor;
  }
  expect(cursor).toBeNull();
  expect(paths).toHaveLength(206);
  expect(new Set(paths).size).toBe(206);
});

test("provides continuation when the only matching journal is beyond the candidate budget", async () => {
  const { directory, manager, tool } = await fixture();
  const original = await readFile(manager.getSessionFile()!, "utf8");
  for (let index = 0; index < 205; index += 1)
    await writeFile(join(directory, `continuation-${index}.jsonl`), original.replaceAll(manager.getSessionId(), `continuation-${index}`));
  // Discover actual filesystem order, rather than assuming filename order.
  const names: string[] = [];
  for await (const entry of await opendir(directory)) if (entry.isFile() && entry.name.endsWith(".jsonl")) names.push(entry.name);
  const target = join(directory, names[205]!);
  const marker = "unique-beyond-candidate-budget";
  await writeFile(target, (await readFile(target, "utf8")).replaceAll("needle", marker));
  const before = await readFile(target);
  const result = (await tool.execute("continuation", { query: marker }, undefined, undefined, {} as never)) as AgentToolResult<SessionSearchReport>;
  expect(result.details).toMatchObject({ scanned: 200, total: 0, truncated: true });
  expect(await readFile(target)).toEqual(before);
  // A partial no-hit result must offer a way to search the remaining journals.
  expect(result.details).toHaveProperty("nextCursor", expect.any(String));
  const cursor = (result.details as SessionSearchReport & { nextCursor: string }).nextCursor;
  const next = (await tool.execute("next", { query: marker, cursor }, undefined, undefined, {} as never)) as AgentToolResult<SessionSearchReport>;
  expect(next.details).toMatchObject({ scanned: 6, total: 1, nextCursor: null, items: [{ path: target }] });
  expect(await readFile(target)).toEqual(before);
  await expect(tool.execute("stale", { query: marker, cursor }, undefined, undefined, {} as never)).rejects.toThrow(/cursor/i);
});

test("invalidates cursors on replacement, native navigation, expiry and cancellation", async () => {
  const { directory, manager, panels, search, tool, context } = await fixture();
  // Observe the actual native close calls; no stub or replacement filesystem.
  const close = vi.spyOn(Dir.prototype, "close");
  // Node's promise overload internally calls close(callback) again.
  const requestedCloses = () => close.mock.calls.filter((args: readonly unknown[]) => args.length === 0).length;
  const original = await readFile(manager.getSessionFile()!, "utf8");
  for (let index = 0; index < 101; index += 1)
    await writeFile(join(directory, `lifecycle-${index}.jsonl`), original.replaceAll(manager.getSessionId(), `lifecycle-${index}`));
  const next = (cursor: string, query = "needle", signal?: AbortSignal) => tool.execute("next", { query, cursor }, signal, undefined, {} as never);
  const first = (await search()).details.nextCursor!;
  await expect(next(first, "another query")).rejects.toThrow(/cursor/);
  // A mistaken query must not consume the valid continuation.
  expect((await next(first)).details).toMatchObject({ total: 2, nextCursor: null });
  expect(requestedCloses()).toBe(1);
  const replaced = (await search()).details.nextCursor!;
  const current = (await search()).details.nextCursor!;
  await expect(next(replaced)).rejects.toThrow(/cursor/);
  expect(requestedCloses()).toBe(2);
  const abort = new AbortController();
  const pending = next(current, "needle", abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow(/cancelled/);
  await expect(next(current)).rejects.toThrow(/cursor/);
  expect(requestedCloses()).toBe(3);
  const navigated = (await search()).details.nextCursor!;
  manager.newSession();
  await panels.snapshot();
  await expect(next(navigated)).rejects.toThrow(/cursor/);
  expect(requestedCloses()).toBe(4);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const expired = (await search()).details.nextCursor!;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await expect(next(expired)).rejects.toThrow(/cursor/);
    expect(requestedCloses()).toBe(5);
  } finally {
    vi.useRealTimers();
  }
  await search();
  await context.fiber.dispose();
  expect(requestedCloses()).toBe(6);
  await Promise.all(close.mock.results.map((result): unknown => result.value));
});

test("rejects overlapping searches without interrupting the active scan", async () => {
  const { search } = await fixture();
  const first = search();
  await expect(search()).rejects.toThrow(/already running/);
  expect((await first).details).toMatchObject({ total: 1, nextCursor: null });
});

test("keeps the active scan when parameter inspection reenters the tool", async () => {
  const { tool, search } = await fixture();
  let nested: Promise<unknown> | undefined;
  const params = new Proxy(
    { query: "needle" },
    {
      ownKeys(target) {
        nested = search().catch((error: unknown) => error);
        return Reflect.ownKeys(target);
      },
    },
  );
  await expect(tool.execute("outer", params, undefined, undefined, {} as never)).rejects.toThrow(/already running/);
  expect(await nested).toMatchObject({ details: { total: 1, nextCursor: null } });
});

test("continues after byte-budget exhaustion without losing valid next-page files", async () => {
  const { directory, manager, search, tool } = await fixture();
  const original = await readFile(manager.getSessionFile()!, "utf8");
  // Nine individually valid 3.7 MiB journals exceed the 32 MiB page budget.
  const padding = JSON.stringify({ type: "custom", data: "x".repeat(3_900_000) });
  for (let index = 0; index < 9; index += 1)
    await writeFile(join(directory, `budget-${index}.jsonl`), original.replaceAll(manager.getSessionId(), `budget-${index}`) + padding + "\n");
  const first = (await search()).details;
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(first.skipped).toBe(0);
  expect(first.byteBudgetUsed).toBeLessThanOrEqual(32 * 1024 * 1024);
  const second = (await tool.execute("next", { query: "needle", cursor: first.nextCursor! }, undefined, undefined, {} as never)).details as SessionSearchReport;
  expect(second).toMatchObject({ nextCursor: null, skipped: 0 });
  const paths = [...first.items, ...second.items].map((item) => item.path);
  expect(paths).toHaveLength(10);
  expect(new Set(paths).size).toBe(10);
});

test("continues directory enumeration beyond 4096 entries", async () => {
  const { directory, search, tool } = await fixture();
  for (let start = 0; start < 4100; start += 32) {
    await Promise.all(Array.from({ length: Math.min(32, 4100 - start) }, (_, offset) => writeFile(join(directory, `inert-${start + offset}.txt`), "")));
  }
  const first = (await search()).details;
  expect(first).toMatchObject({ directoryEntries: 4096, nextCursor: expect.any(String) as unknown });
  const second = (await tool.execute("next", { query: "needle", cursor: first.nextCursor! }, undefined, undefined, {} as never)).details as SessionSearchReport;
  expect(second).toMatchObject({ directoryEntries: 5, nextCursor: null });
  expect(first.total + second.total).toBe(1);
});

test("rejects oversized files and directory errors without claiming complete coverage", async () => {
  const { directory, search } = await fixture();
  await writeFile(join(directory, "large.jsonl"), "x".repeat(4 * 1024 * 1024 + 1));
  expect((await search()).details).toMatchObject({ scanned: 1, skipped: 1 });
  await rm(directory, { recursive: true });
  expect((await search()).details).toMatchObject({ scanned: 0, total: 0 });
  await writeFile(directory, "not a directory");
  await expect(search()).rejects.toThrow(/ENOTDIR/);
});

test("centers previews using original text offsets when case folding expands characters", () => {
  const result = searchSessionEntries([{ type: "message", message: { role: "user", content: `${"İ".repeat(700)}needle${"z".repeat(700)}` } }], "needle");
  expect(result.hits[0]!.text).toContain("needle");
  expect(result.hits[0]!.text).toHaveLength(500);
});

test("charges failed file reads against the overall budget", async () => {
  const { directory, manager, search } = await fixture();
  await rm(manager.getSessionFile()!);
  for (let index = 0; index < 9; index += 1) {
    const file = join(directory, `oversized-${index}.jsonl`);
    await writeFile(file, "");
    await truncate(file, 4 * 1024 * 1024 + 1);
  }
  expect((await search()).details).toMatchObject({ scanned: 0, skipped: 8, total: 0, byteBudgetUsed: 32 * 1024 * 1024, truncated: true });
});

test("captures native scope before inspecting search parameters", async () => {
  const { manager, tool } = await fixture();
  const params = new Proxy(
    { query: "needle" },
    {
      ownKeys(target) {
        manager.newSession();
        return Reflect.ownKeys(target);
      },
    },
  );
  await expect(tool.execute("reentrant", params, undefined, undefined, {} as never)).rejects.toThrow(/context changed/iu);
});
