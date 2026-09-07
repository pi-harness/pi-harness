import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { compareMessageEntries, type SessionCompareMessage } from "../src/index.js";
import sessionComparePlugin from "../src/index.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
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

    expect(compareMessageEntries(left, right)).toEqual({
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
    context.provide("piSession", { manager: { getSessionDir: () => sessionDir } } as never);
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
  });
});
