import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
