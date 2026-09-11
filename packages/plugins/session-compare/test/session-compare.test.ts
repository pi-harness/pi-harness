import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { compareMessageEntries, type SessionCompareMessage } from "../src/index.js";
import sessionComparePlugin from "../src/index.js";

const contexts: Context[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("session compare", () => {
  test("marks per-message preview clipping even when only one message differs", () => {
    const diff = compareMessageEntries([{ role: "user", text: "left".repeat(1_001) }], [{ role: "user", text: "right".repeat(801) }]);
    expect(diff).toMatchObject({ shared: 0, addedCount: 1, removedCount: 1, addedTruncated: true, removedTruncated: true });
    expect(diff.added[0]?.text).toHaveLength(4_000);
    expect(diff.removed[0]?.text).toHaveLength(4_000);
  });

  test("does not mark complete or shared boundary-length messages as clipped", () => {
    const exact = { role: "user", text: "a".repeat(4_000) };
    expect(compareMessageEntries([], [exact])).toMatchObject({ addedTruncated: false, removedTruncated: false });
    const shared = { role: "user", text: "b".repeat(4_001) };
    expect(compareMessageEntries([shared], [shared])).toMatchObject({ shared: 1, addedTruncated: false, removedTruncated: false });
  });

  test("reports added and removed messages by conversation position", () => {
    const left: SessionCompareMessage[] = [
      { role: "user", text: "Keep the API stable" },
      { role: "assistant", text: "I will add a regression test." },
      { role: "assistant", text: "I will add a regression test." },
    ];
    const right: SessionCompareMessage[] = [
      { role: "user", text: "Keep the API stable" },
      { role: "assistant", text: "I added the regression test." },
      { role: "toolResult", text: "vitest: 1 passed" },
    ];

    expect(compareMessageEntries(left, right)).toMatchObject({
      shared: 1,
      added: [
        { role: "assistant", text: "I added the regression test." },
        { role: "toolResult", text: "vitest: 1 passed" },
      ],
      removed: [
        { role: "assistant", text: "I will add a regression test." },
        { role: "assistant", text: "I will add a regression test." },
      ],
    });
  });

  test("detects reordered messages and differences beyond the preview limit", () => {
    const first = { role: "user", text: `same-prefix-${"x".repeat(4_100)}-left` };
    const second = { role: "assistant", text: `same-prefix-${"x".repeat(4_100)}-right` };

    expect(compareMessageEntries([first, second], [second, first])).toMatchObject({ shared: 0, added: [{ role: "assistant" }, { role: "user" }] });
    expect(compareMessageEntries([first], [{ ...first, text: first.text.replace(/left$/u, "right") }])).toMatchObject({ shared: 0 });
  });

  test("compares persisted sessions through the Pi tool registry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-compare-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-compare-agent-"));
    directories.push(cwd, agentDir);
    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const header = (id: string) => ({ type: "session", version: 3, id, timestamp: "2026-09-03T00:00:00.000Z", cwd });
    const message = (id: string, parentId: string | null, role: string, text: string) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-09-03T00:01:00.000Z",
      message: { role, content: [{ type: "text", text }] },
    });
    await writeFile(
      join(sessionDir, "left.jsonl"),
      `${JSON.stringify(header("left"))}\n${JSON.stringify(message("left-1", null, "user", "Ship it"))}\n`,
      "utf8",
    );
    await writeFile(
      join(sessionDir, "right.jsonl"),
      `${JSON.stringify(header("right"))}\n${JSON.stringify(message("right-1", null, "user", "Ship it"))}\n${JSON.stringify(message("right-2", "right-1", "assistant", "Done"))}\n`,
      "utf8",
    );
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piSession", { manager: { getCwd: () => cwd, getSessionId: () => "active", getSessionDir: () => sessionDir } } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(sessionComparePlugin);
    const compare = tools.snapshot().customTools.find((tool) => tool.name === "session_compare");
    expect(compare).toBeDefined();
    await expect(compare!.execute("call-1", { left: "left", right: "right" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        left: { id: "left", messageCount: 1 },
        right: { id: "right", messageCount: 2 },
        shared: 1,
        added: [{ role: "assistant", text: "Done" }],
        removed: [],
        changed: true,
      },
    });
    const controller = new AbortController();
    const pending = compare!.execute("cancel", { left: "left", right: "right" }, controller.signal, undefined, {} as never);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    const result = await compare!.execute("clone", { left: "left", right: "right" }, undefined, undefined, {} as never);
    (result.details as { added: Array<{ text: string }> }).added[0]!.text = "MUTATED";
    expect(JSON.stringify(await context.piPluginUi.snapshot())).not.toContain("MUTATED");
    await writeFile(
      join(sessionDir, "right.jsonl"),
      `${JSON.stringify(header("right"))}\n${JSON.stringify(message("right-long", null, "assistant", "x".repeat(4_001)))}\n`,
      "utf8",
    );
    const clipped = await compare!.execute("clipped", { left: "left", right: "right" }, undefined, undefined, {} as never);
    expect(clipped).toMatchObject({ details: { addedTruncated: true, removedTruncated: false, addedCount: 1, removedCount: 1 } });
    expect(clipped.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("Difference previews are limited") as unknown })]);
    await expect(compare!.execute("invalid", { left: "left", right: "right", extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/Unknown/);
    await context.fiber.dispose();
    await expect(compare!.execute("disposed", { left: "left", right: "right" }, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/);
  });
});

test("retains full mismatch counts beyond display limits", () => {
  const left = Array.from({ length: 65 }, (_, index) => ({ role: "user", text: `left-${index}` }));
  const right = Array.from({ length: 70 }, (_, index) => ({ role: "user", text: `right-${index}` }));
  expect(compareMessageEntries(left, right)).toMatchObject({ shared: 0, addedCount: 70, removedCount: 65, addedTruncated: true, removedTruncated: true });
});

test("clears comparison on native session change and binds scope before parameters", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-compare-native-"));
  directories.push(cwd);
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "native transcript" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const id = manager.getSessionId();
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager });
  context.provide("piTools", new PiToolRegistry());
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(sessionComparePlugin);
  const tool = context.piTools.snapshot().customTools[0]!;
  await tool.execute("warm", { left: id, right: id }, undefined, undefined, {} as never);
  manager.newSession();
  expect((await context.piPluginUi.snapshot())[0]!.data).toMatchObject({ left: null, right: null });
  const params = new Proxy(
    { left: id, right: id },
    {
      ownKeys(target) {
        manager.newSession();
        return Reflect.ownKeys(target);
      },
    },
  );
  await expect(tool.execute("reentrant", params, undefined, undefined, {} as never)).rejects.toThrow(/context changed/iu);
});
