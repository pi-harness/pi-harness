import { access, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { SessionStats, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import costMeterPlugin, { type CostMeterPluginConfig } from "../src/index.js";

const contexts: Context[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })));
});

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "session-1",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 },
    cost: 1,
    ...overrides,
  };
}

async function setup(
  initial = stats(),
  config: CostMeterPluginConfig = {},
  sharedAgentDir?: string,
): Promise<{
  context: Context;
  agentDir: string;
  costPath: string;
  panels: PiPluginUiRegistry;
  tool: ToolDefinition;
  tools: PiToolRegistry;
  setStats: (value: SessionStats) => void;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cost-cwd-"));
  const agentDir = sharedAgentDir ?? (await mkdtemp(join(tmpdir(), "pi-harness-cost-agent-")));
  temporaryDirectories.push(cwd);
  if (sharedAgentDir === undefined) temporaryDirectories.push(agentDir);
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  let current = initial;
  context.provide("piRuntime", { session: { getSessionStats: () => current } } as never);
  await context.plugin(costMeterPlugin, config);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "cost_report");
  if (tool === undefined) throw new Error("cost_report was not registered");
  return {
    context,
    agentDir,
    costPath: join(agentDir, config.fileName ?? "cost-meter.json"),
    panels,
    tool,
    tools,
    setStats: (value) => {
      current = value;
    },
  };
}

describe("cost meter production boundaries", () => {
  test.each([
    ["empty file name", { fileName: "" }],
    ["nested file name", { fileName: "../costs.json" }],
    ["Windows-style nested file name", { fileName: "..\\costs.json" }],
    ["control-character file name", { fileName: "cost\u0000.json" }],
    ["oversized file name", { fileName: "x".repeat(125) + ".json" }],
    ["negative budget", { dailyBudget: -1 }],
    ["sub-precision budget", { dailyBudget: 0.000_000_1 }],
    ["non-finite budget", { dailyBudget: Number.POSITIVE_INFINITY }],
    ["oversized budget", { dailyBudget: 1_000_000_001 }],
    ["zero entries", { maxEntries: 0 }],
    ["fractional entries", { maxEntries: 1.5 }],
    ["too many entries", { maxEntries: 2_001 }],
    ["unknown option", { unsupported: true }],
  ])("rejects invalid %s config", async (_label, config) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cost-config-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-cost-config-agent-"));
    temporaryDirectories.push(cwd, agentDir);
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());

    await expect(context.plugin(costMeterPlugin, config as CostMeterPluginConfig).then(() => undefined)).rejects.toThrow(/cost meter config|invalid config/iu);
  });

  test.each([null, { refresh: "yes" }, { extra: true }])("rejects malformed raw tool parameters %#", async (parameters) => {
    const { tool } = await setup();

    await expect(tool.execute("invalid", parameters as never, undefined, undefined, {} as never)).rejects.toThrow(/cost report parameters/iu);
  });

  test("rejects accessor tool parameters without invoking them", async () => {
    const { tool } = await setup();
    let getterCalls = 0;
    const parameters = Object.defineProperty({}, "refresh", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });

    await expect(tool.execute("accessor", parameters, undefined, undefined, {} as never)).rejects.toThrow(/cost report parameters/iu);
    expect(getterCalls).toBe(0);
  });

  test.each([
    ["session id", stats({ sessionId: "" })],
    ["cost", stats({ cost: Number.NaN })],
    ["message count", stats({ totalMessages: -1 })],
    ["token count", stats({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.NaN } })],
  ])("rejects invalid runtime %s before writing", async (_label, runtimeStats) => {
    const { costPath, tool } = await setup(runtimeStats);

    await expect(tool.execute("refresh", { refresh: true }, undefined, undefined, {} as never)).rejects.toThrow(/session stats/iu);
    await expect(access(costPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("captures session stats synchronously when agent_end is emitted", async () => {
    const initial = stats({ cost: 1, totalMessages: 2 });
    const { context, setStats, tool } = await setup(initial);

    context.emit("pi/session-event", { type: "agent_end", messages: [], willRetry: false });
    setStats(stats({ cost: 2, totalMessages: 3 }));
    const report = await tool.execute("report", {}, undefined, undefined, {} as never);

    expect(report.details).toMatchObject({ sessionCost: 2, lifetimeCost: 1, entries: [{ cost: 1, sessionCost: 1, messages: 2 }] });
  });

  test("rejects a pre-cancelled refresh without creating a ledger", async () => {
    const { agentDir, costPath, tool } = await setup();
    const caller = new AbortController();
    caller.abort(new Error("cancelled by caller"));

    await expect(tool.execute("cancelled", { refresh: true }, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled by caller/iu);
    await expect(access(costPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(agentDir)).toEqual([]);
  });

  test("cancels an in-flight refresh when the plugin context is disposed", async () => {
    const { context, costPath, tool } = await setup();
    const lockPath = `${costPath}.lock`;
    await writeFile(lockPath, "held", "utf8");
    const refresh = tool.execute("dispose", { refresh: true }, undefined, undefined, {} as never);
    const refreshAssertion = expect(refresh).rejects.toThrow(/disposed/iu);

    contexts.splice(contexts.indexOf(context), 1);
    await context.fiber.dispose();
    await unlink(lockPath);

    await refreshAssertion;
    await expect(access(costPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not steal an old lock owned by a live process", async () => {
    const { costPath, tool } = await setup();
    const lockPath = `${costPath}.lock`;
    const owner = JSON.stringify({ pid: process.pid });
    await writeFile(lockPath, owner, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(tool.execute("live-lock", { refresh: true }, undefined, undefined, {} as never)).rejects.toThrow(/persistence lock/iu);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(owner);
    await expect(access(costPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reclaims an old lock whose owner process no longer exists", async () => {
    const { costPath, tool } = await setup();
    const lockPath = `${costPath}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: "abandoned" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(tool.execute("dead-lock", { refresh: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { entries: [{ sessionId: "session-1" }] },
    });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reclaims an old lock with incomplete owner metadata", async () => {
    const { costPath, tool } = await setup();
    const lockPath = `${costPath}.lock`;
    await writeFile(lockPath, JSON.stringify({ token: "partial-write" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(tool.execute("incomplete-lock", { refresh: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { entries: [{ sessionId: "session-1" }] },
    });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("attributes a resumed session's cumulative cost to separate UTC days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const { context, setStats, tool } = await setup(stats({ cost: 1 }));
    context.emit("pi/session-event", { type: "agent_end", messages: [], willRetry: false });
    await tool.execute("day-1", {}, undefined, undefined, {} as never);

    vi.setSystemTime(new Date("2026-01-02T12:00:00.000Z"));
    setStats(stats({ cost: 2, totalMessages: 4 }));
    context.emit("pi/session-event", { type: "agent_end", messages: [], willRetry: false });
    const report = await tool.execute("day-2", {}, undefined, undefined, {} as never);

    expect(report.details).toMatchObject({ todayCost: 1, lifetimeCost: 2 });
    expect((report.details as { entries: Array<{ cost: number; sessionCost: number }> }).entries).toMatchObject([
      { cost: 1, sessionCost: 2 },
      { cost: 1, sessionCost: 1 },
    ]);
  });

  test("preserves earlier daily cost when a session cost counter starts a new segment", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const { context, setStats, tool } = await setup(stats({ cost: 5 }));
    context.emit("pi/session-event", { type: "agent_end", messages: [], willRetry: false });
    await tool.execute("first-segment", {}, undefined, undefined, {} as never);

    vi.setSystemTime(new Date("2026-01-01T13:00:00.000Z"));
    setStats(stats({ cost: 1, totalMessages: 4 }));
    context.emit("pi/session-event", { type: "agent_end", messages: [], willRetry: false });
    const report = await tool.execute("second-segment", {}, undefined, undefined, {} as never);

    expect(report.details).toMatchObject({ todayCost: 6, lifetimeCost: 6 });
    expect((report.details as { entries: Array<{ cost: number; sessionCost: number }> }).entries).toEqual([
      expect.objectContaining({ cost: 6, sessionCost: 1 }),
    ]);
  });

  test("does not persist an aggregate daily entry beyond the cost limit", async () => {
    const { costPath, setStats, tool } = await setup(stats({ cost: 1_000_000_000 }));
    await tool.execute("maximum", { refresh: true }, undefined, undefined, {} as never);
    setStats(stats({ cost: 1, totalMessages: 4 }));

    await expect(tool.execute("overflow", { refresh: true }, undefined, undefined, {} as never)).rejects.toThrow(/daily cost.*limit/iu);

    const stored = JSON.parse(await readFile(costPath, "utf8")) as { entries: Array<{ cost: number }> };
    expect(stored.entries).toEqual([expect.objectContaining({ cost: 1_000_000_000 })]);
  });

  test("accepts exactly the configured entry limit and rejects one entry over it", async () => {
    const { costPath, tool } = await setup(stats(), { maxEntries: 2_000 });
    const entry = (index: number) => ({
      sessionId: `session-${index}`,
      cost: 1,
      sessionCost: 1,
      tokens: 1,
      messages: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(costPath, JSON.stringify({ version: 2, entries: Array.from({ length: 2_000 }, (_, index) => entry(index)) }), "utf8");

    const report = await tool.execute("at-limit", {}, undefined, undefined, {} as never);
    expect((report.details as { entries: unknown[] }).entries).toHaveLength(2_000);

    await writeFile(costPath, JSON.stringify({ version: 2, entries: Array.from({ length: 2_001 }, (_, index) => entry(index)) }), "utf8");
    await expect(tool.execute("over-limit", {}, undefined, undefined, {} as never)).rejects.toThrow(/2000-entry limit/iu);
  });

  test("truncates a ledger holding more entries than the configured limit instead of failing", async () => {
    const { costPath, tool } = await setup(stats(), { maxEntries: 2 });
    const entry = (index: number) => ({
      sessionId: `session-${index}`,
      cost: 1,
      sessionCost: 1,
      tokens: 1,
      messages: 1,
      recordedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    });
    await writeFile(costPath, JSON.stringify({ version: 2, entries: Array.from({ length: 5 }, (_, index) => entry(index)) }), "utf8");

    const report = await tool.execute("lowered-limit", {}, undefined, undefined, {} as never);
    expect((report.details as { entries: Array<{ sessionId: string }> }).entries.map((item) => item.sessionId)).toEqual(["session-0", "session-1"]);

    await expect(tool.execute("record", { refresh: true }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { entryLimit: 2 } });
  });

  test("rejects duplicate version-two session and UTC-day keys", async () => {
    const { costPath, tool } = await setup();
    await writeFile(
      costPath,
      JSON.stringify({
        version: 2,
        entries: [
          { sessionId: "duplicate", cost: 1, sessionCost: 1, tokens: 1, messages: 1, recordedAt: "2026-01-01T00:00:00.000Z" },
          { sessionId: "duplicate", cost: 2, sessionCost: 2, tokens: 2, messages: 2, recordedAt: "2026-01-01T23:59:59.000Z" },
        ],
      }),
      "utf8",
    );

    await expect(tool.execute("duplicate", {}, undefined, undefined, {} as never)).rejects.toThrow(/duplicate entries/iu);
  });

  test("merges concurrent writers that share one ledger", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-cost-shared-agent-"));
    temporaryDirectories.push(agentDir);
    const first = await setup(stats({ sessionId: "session-a", cost: 1 }), {}, agentDir);
    const second = await setup(stats({ sessionId: "session-b", cost: 2 }), {}, agentDir);

    await Promise.all([
      first.tool.execute("first", { refresh: true }, undefined, undefined, {} as never),
      second.tool.execute("second", { refresh: true }, undefined, undefined, {} as never),
    ]);
    const report = await first.tool.execute("merged", {}, undefined, undefined, {} as never);

    expect(report.details).toMatchObject({ lifetimeCost: 3 });
    expect((report.details as { entries: Array<{ sessionId: string }> }).entries.map((entry) => entry.sessionId).sort()).toEqual(["session-a", "session-b"]);
  });

  test("returns isolated report entries", async () => {
    const { tool } = await setup();
    const first = await tool.execute("record", { refresh: true }, undefined, undefined, {} as never);
    const firstEntry = (first.details as { entries: Array<{ sessionId: string }> }).entries[0];
    if (firstEntry === undefined) throw new Error("expected a persisted cost entry");
    firstEntry.sessionId = "mutated";

    const second = await tool.execute("read", {}, undefined, undefined, {} as never);
    expect((second.details as { entries: Array<{ sessionId: string }> }).entries[0]?.sessionId).toBe("session-1");
  });

  test("exposes synchronous event validation errors through the panel", async () => {
    const { context, panels, setStats } = await setup(stats({ cost: Number.NaN }));
    context.emit("pi/session-event", { type: "agent_end", messages: [], willRetry: false });
    setStats(stats());

    const panel = (await panels.snapshot())[0];
    expect(panel).toMatchObject({ id: "cost-meter-panel", data: { dayBasis: "UTC", entryLimit: 365 } });
    expect((panel?.data as { lastError?: unknown }).lastError).toMatch(/session stats/iu);
  });

  test("unregisters its tool and panel when disposed", async () => {
    const { context, panels, tools } = await setup();
    expect(tools.snapshot().customTools.map((entry) => entry.name)).toEqual(["cost_report"]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "cost-meter-panel" }]);

    contexts.splice(contexts.indexOf(context), 1);
    await context.fiber.dispose();

    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("migrates a valid version-one ledger on the next refresh", async () => {
    const { costPath, tool } = await setup(stats({ sessionId: "new-session", cost: 2 }));
    await writeFile(
      costPath,
      JSON.stringify({
        version: 1,
        entries: [{ sessionId: "legacy", cost: 1, tokens: 10, messages: 2, recordedAt: "2025-01-01T00:00:00.000Z" }],
      }),
      "utf8",
    );

    await tool.execute("migrate", { refresh: true }, undefined, undefined, {} as never);

    const stored = JSON.parse(await readFile(costPath, "utf8")) as { version: number; entries: Array<{ sessionCost?: number }> };
    expect(stored.version).toBe(2);
    expect(stored.entries.every((entry) => typeof entry.sessionCost === "number")).toBe(true);
  });
});
