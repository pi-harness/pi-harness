import { Context } from "@deepseek-ai/cordis";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import runtimePlugin from "@pi-harness/core/plugins/runtime";
import { createTestRuntimeServices } from "@pi-harness/core/test-harness";
import historyCompressorPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, tryAcquireSessionCompaction } from "@pi-harness/plugin-api";
import sessionInsightsPlugin from "@pi-harness/plugin-session-insights";

const contexts: Context[] = [];

async function fixture(usagePercent = 90, isIdle?: boolean) {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  const compact = vi.fn().mockResolvedValue(undefined);
  const usage = { percent: usagePercent };
  const session = { getContextUsage: () => ({ percent: usage.percent }), compact, isIdle, subscribe: vi.fn(() => () => undefined) };
  context.provide("piRuntime", { session } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(historyCompressorPlugin, { enabled: true, thresholdPercent: 85 });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "compress_history");
  if (tool === undefined) throw new Error("compress_history was not registered");
  return { context, tools, panels, tool, compact, session, usage };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("history compressor", () => {
  test("reapplies cancellation after the SDK initializes its compaction controller", async () => {
    const { tool, compact, session } = await fixture(10, true);
    let listener: ((event: { type: string }) => void) | undefined;
    let ready = false;
    let aborted = false;
    let requests = 0;
    const unsubscribe = vi.fn();
    Object.assign(session, {
      subscribe: (callback: typeof listener) => {
        listener = callback;
        return unsubscribe;
      },
      abortCompaction: () => {
        if (ready) aborted = true;
      },
    });
    compact.mockImplementation(async () => {
      await Promise.resolve();
      ready = true;
      listener?.({ type: "compaction_start" });
      if (aborted) throw new Error("Compaction cancelled");
      requests += 1;
    });
    const controller = new AbortController();
    const operation = tool.execute("initializing", { confirm: true }, controller.signal, undefined, {} as never);
    const rejection = expect(operation).rejects.toThrow(/cancelled/i);
    controller.abort(new Error("Request cancelled"));
    await rejection;
    expect(requests).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("rejects cancelled and disposed tool calls before compaction", async () => {
    const { context, tool, compact } = await fixture(10, true);
    const controller = new AbortController();
    controller.abort(new Error("Cancelled request"));
    await expect(tool.execute("cancelled", { confirm: true }, controller.signal, undefined, {} as never)).rejects.toThrow("Cancelled request");
    await context.fiber.dispose();
    await expect(tool.execute("disposed", { confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/);
    expect(compact).not.toHaveBeenCalled();
  });

  test("removes a cancelled queued request before the session settles", async () => {
    const { context, tool, compact, session, panels } = await fixture(10, false);
    const controller = new AbortController();
    await tool.execute("queued", { confirm: true }, controller.signal, undefined, {} as never);
    controller.abort(new Error("Queued request cancelled"));
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await Promise.resolve();
    expect(compact).not.toHaveBeenCalled();
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: false, compactions: 0 } }]);
  });

  test("cancels a queued request when the active session is replaced", async () => {
    const { context, tool, compact, panels } = await fixture(10, false);
    await expect(tool.execute("queued", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { queued: true } });
    const replacementCompact = vi.fn().mockResolvedValue(undefined);
    const replacement = {
      getContextUsage: () => ({ percent: 10 }),
      compact: replacementCompact,
      abortCompaction: vi.fn(),
      isIdle: true,
      subscribe: vi.fn(() => () => undefined),
    };
    context.reflect.set("piRuntime", { session: replacement });

    await expect(panels.snapshot()).resolves.toMatchObject([
      { data: { queued: false, compactions: 0, lastError: "Session changed before the queued history compaction could start" } },
    ]);
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await Promise.resolve();
    expect(compact).not.toHaveBeenCalled();
    expect(replacementCompact).not.toHaveBeenCalled();
  });

  test("aborts only the captured session's active compaction", async () => {
    const { tool, compact, session, panels } = await fixture(10, true);
    const controller = new AbortController();
    let rejectOperation!: (error: Error) => void;
    compact.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectOperation = reject;
        }),
    );
    const abort = vi.fn(() => rejectOperation(new Error("Compaction cancelled")));
    Object.assign(session, { abortCompaction: abort });
    const operation = tool.execute("running", { confirm: true }, controller.signal, undefined, {} as never);
    const rejection = expect(operation).rejects.toThrow(/cancelled/i);
    controller.abort(new Error("Running request cancelled"));
    await rejection;
    expect(abort).toHaveBeenCalledTimes(1);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { compactions: 0 } }]);
  });

  test("returns caller cancellation while a stalled native compaction keeps the single-flight lock", async () => {
    const { tool, compact, session, panels } = await fixture(10, true);
    let resolveNative!: () => void;
    compact
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveNative = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const abortCompaction = vi.fn();
    const unsubscribe = vi.fn();
    Object.assign(session, { abortCompaction, subscribe: vi.fn(() => unsubscribe) });

    const controller = new AbortController();
    const operation = tool.execute("stalled", { confirm: true }, controller.signal, undefined, {} as never);
    let outcome: string | undefined;
    void operation.then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));

    controller.abort(new Error("caller cancelled stalled compaction"));
    await vi.waitFor(() => expect(outcome).toBe("caller cancelled stalled compaction"));
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    await expect(tool.execute("overlap", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compacted: false, queued: false },
      content: [{ type: "text", text: "Session compaction is already running." }],
    });

    resolveNative();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    await expect(tool.execute("after-cleanup", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compacted: true },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { compactions: 1 } }]);
  });

  test("cancels an old session's stalled compaction without releasing its native lock early", async () => {
    const { context, tool, compact, session, panels } = await fixture(10, true);
    let resolveOld!: () => void;
    compact.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const oldAbort = vi.fn();
    const oldUnsubscribe = vi.fn();
    Object.assign(session, { abortCompaction: oldAbort, subscribe: vi.fn(() => oldUnsubscribe) });
    const operation = tool.execute("old-session", { confirm: true }, undefined, undefined, {} as never);
    let outcome: string | undefined;
    void operation.then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));

    const replacementCompact = vi.fn().mockResolvedValue(undefined);
    const replacement = {
      getContextUsage: () => ({ percent: 10 }),
      compact: replacementCompact,
      abortCompaction: vi.fn(),
      isIdle: true,
      subscribe: vi.fn(() => () => undefined),
    };
    context.reflect.set("piRuntime", { session: replacement });
    await panels.snapshot();
    await vi.waitFor(() => expect(outcome).toBe("Session changed while history compaction was running"));
    expect(oldAbort).toHaveBeenCalledTimes(1);
    await expect(tool.execute("replacement-overlap", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compacted: false, queued: false },
    });

    resolveOld();
    await vi.waitFor(() => expect(oldUnsubscribe).toHaveBeenCalledTimes(1));
    await expect(tool.execute("replacement", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compacted: true },
    });
    expect(replacementCompact).toHaveBeenCalledTimes(1);
  });

  test("consumes a late native rejection after caller cancellation and releases the lock", async () => {
    const { tool, compact, session } = await fixture(10, true);
    let rejectNative!: (error: Error) => void;
    compact
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectNative = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const unsubscribe = vi.fn();
    Object.assign(session, { abortCompaction: vi.fn(), subscribe: vi.fn(() => unsubscribe) });
    const controller = new AbortController();
    const operation = tool.execute("late-rejection", { confirm: true }, controller.signal, undefined, {} as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));

    controller.abort(new Error("caller stopped waiting for rejection"));
    await expect(operation).rejects.toThrow("caller stopped waiting for rejection");
    rejectNative(new Error("late provider rejection"));
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    await expect(tool.execute("after-rejection", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compacted: true },
    });
  });

  test("returns plugin disposal promptly while native compaction finishes cleanup independently", async () => {
    const { context, tool, compact, session, tools, panels } = await fixture(10, true);
    let resolveNative!: () => void;
    compact.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveNative = resolve;
        }),
    );
    const abortCompaction = vi.fn();
    const unsubscribe = vi.fn();
    Object.assign(session, { abortCompaction, subscribe: vi.fn(() => unsubscribe) });
    const operation = tool.execute("dispose-running", { confirm: true }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));

    await context.fiber.dispose();
    await expect(operation).rejects.toThrow(/disposed/iu);
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);

    resolveNative();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });

  test("compacts explicitly and automatically at the configured threshold", async () => {
    const { context, tool, compact, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(tool.execute("manual", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compacted: true, automatic: false },
    });
    context.emit("pi/session-event", { type: "agent_end" } as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2));
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { compactions: 2, lastUsagePercent: 90 } }]);
  });

  test("does not overlap a compaction owned by another plugin", async () => {
    const { tool, compact, session } = await fixture(10, true);
    const release = tryAcquireSessionCompaction(session);
    expect(release).toEqual(expect.any(Function));
    try {
      await expect(tool.execute("shared-lock", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
        content: [{ type: "text", text: "Session compaction is already running." }],
        details: { compacted: false, queued: false },
      });
      expect(compact).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
    await expect(tool.execute("after-shared-lock", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compacted: true },
    });
  });

  test("queues a confirmed compaction until the busy agent run settles", async () => {
    const { context, tool, compact, panels, session } = await fixture(10, false);
    await expect(tool.execute("manual", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ type: "text", text: "Session compaction queued until the current agent run settles." }],
      details: { compacted: false, queued: true },
    });
    expect(compact).not.toHaveBeenCalled();
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: true, compactions: 0 } }]);
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: false, compactions: 1 } }]);
  });

  test("defers automatic compaction from agent_end until the session reports it is idle", async () => {
    const { context, compact, session } = await fixture(90, false);
    context.emit("pi/session-event", { type: "agent_end" } as never);
    await Promise.resolve();
    expect(compact).not.toHaveBeenCalled();
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
  });

  test("drops a queued automatic compaction when usage fell back below the threshold", async () => {
    const { context, compact, session, panels, usage } = await fixture(90, false);
    context.emit("pi/session-event", { type: "agent_end" } as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: true, lastUsagePercent: 90 } }]);
    usage.percent = 12;
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await Promise.resolve();
    expect(compact).not.toHaveBeenCalled();
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: false, compactions: 0, lastUsagePercent: 12 } }]);
  });

  test("still runs a queued explicit compaction after usage fell below the threshold", async () => {
    const { context, tool, compact, session, usage } = await fixture(90, false);
    await expect(tool.execute("manual", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { queued: true } });
    usage.percent = 12;
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
  });

  test("requires explicit confirmation and removes registrations on disposal", async () => {
    const { context, tool, tools, panels } = await fixture(10);
    await expect(tool.execute("manual", { confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("compacts a long SaaS support workflow through a real AgentSession and keeps session reporting coherent", async () => {
    let stalledSummaryStarted!: () => void;
    const summaryStarted = new Promise<void>((resolve) => {
      stalledSummaryStarted = resolve;
    });
    const stalledSummary = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
      new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
        stalledSummaryStarted();
        const finish = (): void => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "fixture summary cancelled" }));
        if (options?.signal?.aborted) finish();
        else options?.signal?.addEventListener("abort", finish, { once: true });
      });
    const { context, faux } = await createTestRuntimeServices([
      fauxAssistantMessage("The bulk ticket import is tenant-safe; 18 malformed rows need review."),
      fauxAssistantMessage("Compacted onboarding, tenant isolation, billing, and import decisions."),
      fauxAssistantMessage("The migration preview preserves tenant IDs and SLA clocks."),
      fauxAssistantMessage("Compacted the migration validation and rollback evidence."),
      fauxAssistantMessage("The incident timeline points to one delayed webhook partition."),
      stalledSummary,
    ]);
    const { cwd, agentDir } = context.piHarnessLaunch;
    try {
      await context.plugin(historyCompressorPlugin, { enabled: true, thresholdPercent: 85 });
      await context.plugin(sessionInsightsPlugin);
      // Disable the SDK's own automatic threshold so this scenario exercises the plugin's automatic scheduler; manual AgentSession.compact() remains available.
      context.piResources.settingsManager.applyOverrides({ compaction: { enabled: false, reserveTokens: 4_000, keepRecentTokens: 45_000 } });
      for (let tenant = 1; tenant <= 6; tenant += 1) {
        context.piSession.manager.appendMessage({
          role: "user",
          content: `Tenant ${tenant} support backlog, escalation history, SLA policy, and audit notes:\n${`ticket-${tenant}-timeline `.repeat(1_700)}`,
          timestamp: tenant * 2,
        });
        context.piSession.manager.appendMessage(fauxAssistantMessage(`Tenant ${tenant} triage and remediation record: ${"validated handoff ".repeat(180)}`));
      }
      await context.plugin(runtimePlugin, { thinkingLevel: "off" });

      const tools = context.piTools.snapshot().customTools;
      const historyTool = tools.find((candidate) => candidate.name === "compress_history");
      const reportTool = tools.find((candidate) => candidate.name === "session_report");
      if (historyTool === undefined || reportTool === undefined) throw new Error("Long-session tools were not registered");
      const initial = await reportTool.execute("initial-report", {}, undefined, undefined, {} as never);
      expect(initial.details).toMatchObject({ userMessages: 6, assistantMessages: 6, compaction: { status: "idle" } });
      const initialPercent = (initial.details as { contextUsage: { percent: number } }).contextUsage.percent;
      expect(initialPercent).toBeLessThan(85);

      context.emit("pi/session-event", { type: "agent_end" } as never);
      await Promise.resolve();
      expect(faux.state.callCount).toBe(0);

      let queuedSnapshot: ReturnType<PiPluginUiRegistry["snapshot"]> | undefined;
      const stopQueueObserver = context.on("pi/session-event", (event) => {
        if (event.type === "agent_end" && faux.state.callCount === 1) queuedSnapshot = context.piPluginUi.snapshot();
      });
      await context.piRuntime.prompt(
        `Bulk-import this tenant-safe ticket archive and preserve every SLA boundary:\n${"tenant,row,status,owner,deadline\n".repeat(5_000)}`,
      );
      stopQueueObserver();
      if (queuedSnapshot === undefined) throw new Error("History Compressor did not expose its queued state at agent_end");
      const queuedPanels = await queuedSnapshot;
      const queuedHistoryData: unknown = queuedPanels.find((panel) => panel.pluginId === "@pi-harness/plugin-history-compressor")?.data;
      expect(queuedHistoryData).toMatchObject({ queued: true });
      await expect
        .poll(async () => {
          const data: unknown = (await context.piPluginUi.snapshot()).find((panel) => panel.pluginId === "@pi-harness/plugin-history-compressor")?.data;
          if (data === null || typeof data !== "object") return false;
          const record = data as Record<string, unknown>;
          return record.compactions === 1 && record.queued === false && typeof record.lastUsagePercent === "number";
        })
        .toBe(true);
      expect(faux.state.callCount).toBe(2);

      context.piResources.settingsManager.applyOverrides({ compaction: { enabled: false, reserveTokens: 4_000, keepRecentTokens: 1_000 } });
      await context.piRuntime.prompt(
        `Validate this tenant migration preview without triggering threshold compaction:\n${"migration-row validated\n".repeat(100)}`,
      );
      expect(faux.state.callCount).toBe(3);
      const migrationPanel = (await context.piPluginUi.snapshot()).find((panel) => panel.pluginId === "@pi-harness/plugin-history-compressor")?.data as {
        compactions: number;
        lastUsagePercent: number | null;
        queued: boolean;
      };
      expect(migrationPanel.lastUsagePercent).toBeLessThan(85);
      expect(migrationPanel).toMatchObject({ compactions: 1, queued: false });
      const compactedReport = await reportTool.execute("report-and-compact", { compact: true, confirm: true }, undefined, undefined, {} as never);
      expect(compactedReport.details).toMatchObject({ compaction: { status: "completed" }, contextUsage: { tokens: null, percent: null } });
      expect(faux.state.callCount).toBe(4);

      context.piResources.settingsManager.applyOverrides({ compaction: { enabled: false, reserveTokens: 4_000, keepRecentTokens: 2_500 } });
      await context.piRuntime.prompt(
        `Investigate the delayed webhook partition from this incident export:\n${"webhook delivery delayed but deduplicated\n".repeat(200)}`,
      );
      expect(faux.state.callCount).toBe(5);
      const controller = new AbortController();
      const cancelled = historyTool.execute("cancel-native-summary", { confirm: true }, controller.signal, undefined, {} as never);
      await summaryStarted;
      controller.abort(new Error("operator stopped stalled model summary"));
      await expect(cancelled).rejects.toThrow("operator stopped stalled model summary");
      await vi.waitFor(() => expect(context.piRuntime.session.isCompacting).toBe(false));
      const finalPanels = await context.piPluginUi.snapshot();
      const finalHistoryData: unknown = finalPanels.find((panel) => panel.pluginId === "@pi-harness/plugin-history-compressor")?.data;
      const finalInsightsData: unknown = finalPanels.find((panel) => panel.pluginId === "@pi-harness/plugin-session-insights")?.data;
      expect(finalHistoryData).toMatchObject({ compactions: 1, queued: false, lastError: "operator stopped stalled model summary" });
      expect(finalInsightsData).toMatchObject({ sessionId: context.piRuntime.session.sessionId });
      expect(faux.state.callCount).toBe(6);
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
      if (agentDir !== cwd) await rm(agentDir, { recursive: true, force: true });
    }
  });
});
