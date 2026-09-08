import { mkdtemp, readFile, writeFile, truncate, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { afterEach, describe, expect, test } from "vitest";
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

  test("centers long previews around the matching text", () => {
    const result = searchSessionEntries([{ type: "message", message: { role: "user", content: `${"x".repeat(700)}needle${"y".repeat(700)}` } }], "needle");
    expect(result.hits[0]?.text).toContain("needle");
    expect(result.hits[0]?.text).toHaveLength(500);
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
  const { directory, manager, search } = await fixture();
  const original = await readFile(manager.getSessionFile()!, "utf8");
  for (let index = 0; index < 205; index += 1)
    await writeFile(join(directory, `copy-${index}.jsonl`), original.replaceAll(manager.getSessionId(), `copy-${index}`));
  const result = await search();
  expect(result.details).toMatchObject({ scanned: 200, skipped: 0, total: 200, truncated: true });
  expect(result.details.items).toHaveLength(100);
  expect(result.details.items.every((item) => item.totalHits === 2)).toBe(true);
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
