import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import turnRewindPlugin, { scanRewindCandidates, selectRewindTarget } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createTurnRewind(streaming: boolean, navigate?: () => Promise<{ cancelled: boolean; editorText?: string }>) {
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  const navigations: Array<{ entryId: string; summarize: boolean }> = [];
  const rawNavigations: Array<{ entryId: string; summarize: boolean }> = [];
  const commandContextNavigations: Array<{ entryId: string; summarize: boolean }> = [];
  let candidateScans = 0;
  const entries = new Map<string, unknown>([
    ["u1", { type: "message", id: "u1", parentId: null, message: { role: "user", content: "第一轮" } }],
    ["u2", { type: "message", id: "u2", parentId: "u1", message: { role: "user", content: "第二轮" } }],
  ]);
  context.provide("piRuntime", {
    session: {
      sessionId: "initial-session",
      isIdle: !streaming,
      isStreaming: streaming,
      sessionManager: {
        getLeafEntry: () => {
          candidateScans += 1;
          return entries.get("u2");
        },
        getEntry: (id: string) => entries.get(id),
      },
      extensionRunner: {
        createCommandContext: () => ({
          navigateTree: async (entryId: string, options: { summarize: boolean }) => {
            commandContextNavigations.push({ entryId, summarize: options.summarize });
            navigations.push({ entryId, summarize: options.summarize });
            return (await navigate?.()) ?? { cancelled: false, editorText: "第二轮" };
          },
        }),
      },
      navigateTree: async (entryId: string, options: { summarize: boolean }) => {
        rawNavigations.push({ entryId, summarize: options.summarize });
        navigations.push({ entryId, summarize: options.summarize });
        return (await navigate?.()) ?? { cancelled: false, editorText: "第二轮" };
      },
    },
  } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(turnRewindPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_rewind");
  if (tool === undefined) throw new Error("Turn Rewind tool was not registered");
  const settle = () => {
    Object.assign(context.piRuntime.session, { isIdle: true, isStreaming: false });
    context.emit("pi/session-event", { type: "agent_settled" });
  };
  return { context, panels, tool, navigations, rawNavigations, commandContextNavigations, settle, candidateScans: () => candidateScans };
}

describe("turn rewind", () => {
  test("scans user turns only from the current native session branch", () => {
    const entries = new Map<string, unknown>([
      ["u1", { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "first" }] } }],
      ["a1", { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }],
      ["u2", { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "second" }] } }],
      ["a2", { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "current" }] } }],
      ["abandoned", { type: "message", id: "abandoned", parentId: "a1", message: { role: "user", content: "not active" } }],
    ]);
    const inventory = scanRewindCandidates({
      getLeafEntry: () => entries.get("a2"),
      getEntry: (id: string) => entries.get(id),
    });

    expect(inventory).toMatchObject({
      candidates: [
        { entryId: "u1", text: "first" },
        { entryId: "u2", text: "second" },
      ],
      scannedEntries: 4,
      scanTruncated: false,
      candidateTruncated: false,
    });
  });

  test("does not execute entry, message, content, or array accessors while scanning candidates", () => {
    let accessed = false;
    const hostilePart = {};
    Object.defineProperties(hostilePart, {
      type: {
        enumerable: true,
        get() {
          accessed = true;
          throw new Error("content type getter executed");
        },
      },
      text: {
        enumerable: true,
        get() {
          accessed = true;
          throw new Error("content text getter executed");
        },
      },
    });
    const content = Array.from({ length: 1_000 }, () => ({ type: "image", data: "ignored" })) as unknown[];
    Object.defineProperty(content, "1000", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("content array getter executed");
      },
    });
    const hostileEntry = { parentId: null };
    Object.defineProperties(hostileEntry, {
      type: {
        enumerable: true,
        get() {
          accessed = true;
          throw new Error("entry type getter executed");
        },
      },
      message: {
        enumerable: true,
        get() {
          accessed = true;
          throw new Error("entry message getter executed");
        },
      },
    });
    const safeEntry = {
      type: "message",
      id: "safe",
      parentId: "hostile",
      message: { role: "user", content: [hostilePart, { type: "text", text: "x".repeat(800) }] },
    };
    const oversizedContentEntry = {
      type: "message",
      id: "parts",
      parentId: "safe",
      message: { role: "user", content },
    };
    const entries = new Map<string, unknown>([
      ["parts", oversizedContentEntry],
      ["safe", safeEntry],
      ["hostile", hostileEntry],
    ]);

    expect(
      scanRewindCandidates({
        getLeafEntry: () => entries.get("parts"),
        getEntry: (id: string) => entries.get(id),
      }),
    ).toMatchObject({ candidates: [{ entryId: "safe", text: "x".repeat(500) }], scannedEntries: 3 });
    expect(accessed).toBe(false);
  });

  test("bounds branch traversal and keeps only the newest fifty user turns", () => {
    const userEntry = (index: number) => ({
      type: "message",
      id: `u${index}`,
      parentId: index === 0 ? null : `u${index - 1}`,
      message: { role: "user", content: `turn ${index}` },
    });
    const sixty = Array.from({ length: 60 }, (_, index) => userEntry(index));
    const entries = new Map(sixty.map((entry) => [entry.id, entry]));
    const inventory = scanRewindCandidates({
      getLeafEntry: () => entries.get("u59"),
      getEntry: (id: string) => entries.get(id),
    });
    expect(inventory.candidates).toHaveLength(50);
    expect(inventory.candidates[0]).toEqual({ entryId: "u10", text: "turn 10" });
    expect(inventory.candidates[49]).toEqual({ entryId: "u59", text: "turn 59" });
    expect(inventory).toMatchObject({ scannedEntries: 60, scanTruncated: false, candidateTruncated: true });

    let reads = 0;
    const bounded = scanRewindCandidates({
      getLeafEntry: () => userEntry(4_999),
      getEntry: (id: string) => {
        reads += 1;
        return userEntry(Number(id.slice(1)));
      },
    });
    expect(bounded.scannedEntries).toBe(4_096);
    expect(reads).toBe(4_096);
    expect(bounded.scanTruncated).toBe(true);
    expect(bounded.candidates).toHaveLength(50);
  });

  test("selects a previous user turn from the native fork candidates", () => {
    const candidates = [
      { entryId: "u1", text: "第一轮" },
      { entryId: "u2", text: "第二轮" },
      { entryId: "u3", text: "第三轮" },
    ];
    expect(selectRewindTarget(candidates, 1)).toEqual({ entryId: "u3", text: "第三轮" });
    expect(selectRewindTarget(candidates, 3)).toEqual({ entryId: "u1", text: "第一轮" });
    expect(selectRewindTarget(candidates, 4)).toBeUndefined();
  });

  test("rejects invalid turn counts instead of choosing an unexpected branch", () => {
    expect(() => selectRewindTarget([{ entryId: "u1", text: "only" }], 0)).toThrow("Turn rewind count must be between 1 and 20");
    expect(() => selectRewindTarget([{ entryId: "u1", text: "only" }], 21)).toThrow("Turn rewind count must be between 1 and 20");
  });

  test("queues a rewind requested by an active agent run until that run settles", async () => {
    const fixture = await createTurnRewind(true);
    try {
      await expect(fixture.tool.execute("queued", { turns: 1 }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { status: "queued", target: { entryId: "u2", text: "第二轮" }, summarized: false },
      });
      expect(fixture.navigations).toEqual([]);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: { status: "queued" } } }]);

      fixture.settle();
      await expect.poll(() => fixture.navigations).toEqual([{ entryId: "u2", summarize: false }]);
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ latest: { status: "completed" } });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("starts the rewind when the authoritative settled event arrives", async () => {
    const fixture = await createTurnRewind(true);
    try {
      await fixture.tool.execute("queued", {}, undefined, undefined, {} as never);
      fixture.context.emit("pi/session-event", { type: "agent_settled" });
      await Promise.resolve();
      await expect.poll(() => fixture.navigations).toHaveLength(1);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels stale queued targets when the same native session object opens another session", async () => {
    const fixture = await createTurnRewind(true);
    try {
      await fixture.tool.execute("queued", {}, undefined, undefined, {} as never);
      Object.assign(fixture.context.piRuntime.session, { sessionId: "replacement-session" });
      fixture.settle();
      await Promise.resolve();
      expect(fixture.navigations).toEqual([]);
      expect((await fixture.panels.snapshot())[0]?.data).toMatchObject({
        latest: { status: "cancelled", error: "Session changed before the queued rewind could start" },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test.each(["panel", "tool"])("releases a stale queue on %s access before another settlement", async (access) => {
    const fixture = await createTurnRewind(true);
    try {
      await fixture.tool.execute("queued", {}, undefined, undefined, {} as never);
      Object.assign(fixture.context.piRuntime.session, { sessionId: "replacement-session", isIdle: true, isStreaming: false });
      if (access === "panel") expect((await fixture.panels.snapshot())[0]?.data).toMatchObject({ latest: { status: "cancelled" } });
      await expect(fixture.tool.execute("new", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { status: "completed" } });
      expect(fixture.navigations).toHaveLength(1);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("refreshes candidates after an in-place native session switch without a settled event", async () => {
    const fixture = await createTurnRewind(false);
    try {
      Object.assign(fixture.context.piRuntime.session, {
        sessionId: "replacement-session",
        sessionManager: {
          getLeafEntry: () => ({ type: "message", id: "new", parentId: null, message: { role: "user", content: "新会话" } }),
          getEntry: () => undefined,
        },
      });
      expect((await fixture.panels.snapshot())[0]?.data).toMatchObject({ candidates: [{ entryId: "new", text: "新会话" }] });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects a second rewind while another request is queued", async () => {
    const fixture = await createTurnRewind(true);
    try {
      await expect(fixture.tool.execute("first", { turns: 1 }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { status: "queued", target: { entryId: "u2" } },
      });
      await expect(fixture.tool.execute("second", { turns: 2 }, undefined, undefined, {} as never)).rejects.toThrow(/rewind.*already.*progress/iu);

      fixture.settle();
      await expect.poll(() => fixture.navigations).toEqual([{ entryId: "u2", summarize: false }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects overlapping native navigations", async () => {
    const navigation = deferred<{ cancelled: boolean; editorText?: string }>();
    const fixture = await createTurnRewind(false, () => navigation.promise);
    const first = fixture.tool.execute("first", { turns: 1 }, undefined, undefined, {} as never);
    try {
      await expect.poll(() => fixture.navigations).toHaveLength(1);
      await expect(fixture.tool.execute("second", { turns: 2 }, undefined, undefined, {} as never)).rejects.toThrow(/rewind.*already.*progress/iu);
      expect(fixture.navigations).toHaveLength(1);
      navigation.resolve({ cancelled: false, editorText: "第二轮" });
      await expect(first).resolves.toMatchObject({ details: { status: "completed", target: { entryId: "u2" } } });
    } finally {
      navigation.resolve({ cancelled: false });
      await Promise.allSettled([first]);
      await fixture.context.fiber.dispose();
    }
  });

  test("reports native cancellation distinctly and bounds returned editor text", async () => {
    const fixture = await createTurnRewind(false, () => Promise.resolve({ cancelled: true, editorText: `edit\0${"x".repeat(8_000)}` }));
    try {
      const result = await fixture.tool.execute("cancelled", { turns: 1, summarize: true }, undefined, undefined, {} as never);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
      expect(result.details).toMatchObject({
        status: "cancelled",
        target: { entryId: "u2", text: "第二轮" },
        cancelled: true,
        summarized: true,
      });
      expect((result.details as { editorText: string }).editorText).toHaveLength(4_096);
      expect((result.details as { editorText: string }).editorText).not.toContain("\0");
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        { data: { latest: { status: "cancelled", cancelled: true }, limits: { editorTextCharacters: 4_096, errorCharacters: 2_000 } } },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("records bounded navigation failures without invoking hostile error coercion", async () => {
    let accessed = false;
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        accessed = true;
        throw new Error("error message getter executed");
      },
    });
    let attempt = 0;
    const fixture = await createTurnRewind(false, () => Promise.reject(++attempt === 1 ? new Error("x".repeat(3_000)) : hostile));
    try {
      await expect(fixture.tool.execute("long-error", { turns: 1 }, undefined, undefined, {} as never)).rejects.toThrow();
      let panel = (await fixture.panels.snapshot())[0];
      expect(panel?.data).toMatchObject({ latest: { status: "failed" } });
      expect((panel?.data as { latest: { error: string } }).latest.error).toHaveLength(2_000);

      await expect(fixture.tool.execute("hostile-error", { turns: 1 }, undefined, undefined, {} as never)).rejects.toBe(hostile);
      expect(accessed).toBe(false);
      panel = (await fixture.panels.snapshot())[0];
      expect(panel?.data).toMatchObject({ latest: { status: "failed", error: "Unknown session rewind error" } });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not navigate for an already-cancelled request", async () => {
    const fixture = await createTurnRewind(false);
    const caller = new AbortController();
    caller.abort(new Error("caller cancelled"));
    try {
      await expect(fixture.tool.execute("cancel-before-start", { turns: 1 }, caller.signal, undefined, {} as never)).rejects.toThrow(/rewind.*cancelled/iu);
      expect(fixture.navigations).toEqual([]);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: { status: "cancelled" } } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels a queued rewind when its caller aborts before the agent settles", async () => {
    const fixture = await createTurnRewind(true);
    const caller = new AbortController();
    try {
      await expect(fixture.tool.execute("queued", { turns: 1 }, caller.signal, undefined, {} as never)).resolves.toMatchObject({
        details: { status: "queued" },
      });
      caller.abort(new Error("caller stopped"));
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ latest: { status: "cancelled" } });

      fixture.settle();
      await Promise.resolve();
      expect(fixture.navigations).toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("lets a caller stop waiting without pretending an active native navigation was cancelled", async () => {
    const navigation = deferred<{ cancelled: boolean; editorText?: string }>();
    const fixture = await createTurnRewind(false, () => navigation.promise);
    const caller = new AbortController();
    const result = fixture.tool.execute("active", { turns: 1 }, caller.signal, undefined, {} as never);
    let outcome = "pending";
    void result.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    try {
      await expect.poll(() => fixture.navigations).toHaveLength(1);
      caller.abort(new Error("caller stopped waiting"));
      await expect.poll(() => outcome).toBe("rejected");
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: { status: "running" } } }]);

      navigation.resolve({ cancelled: false, editorText: "done" });
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ latest: { status: "completed" } });
    } finally {
      navigation.resolve({ cancelled: false });
      await Promise.allSettled([result]);
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels a queued rewind instead of applying its stale target after session replacement", async () => {
    const fixture = await createTurnRewind(true);
    const replacementNavigations: string[] = [];
    try {
      await expect(fixture.tool.execute("queued", { turns: 1 }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { status: "queued", target: { entryId: "u2" } },
      });
      fixture.context.reflect.set("piRuntime", {
        session: {
          isIdle: true,
          isStreaming: false,
          sessionManager: {
            getLeafEntry: () => ({ type: "message", id: "replacement", parentId: null, message: { role: "user", content: "new session" } }),
            getEntry: () => undefined,
          },
          navigateTree: (entryId: string) => {
            replacementNavigations.push(entryId);
            return Promise.resolve({ cancelled: false });
          },
        },
      });

      fixture.settle();
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ latest: { status: "cancelled" } });
      const panel = (await fixture.panels.snapshot())[0]?.data as { latest: { error: string } };
      expect(panel.latest.error).toMatch(/session.*changed/iu);
      expect(fixture.navigations).toEqual([]);
      expect(replacementNavigations).toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("scans candidates at startup and serves repeated panel reads from a cache", async () => {
    const fixture = await createTurnRewind(false);
    try {
      expect(fixture.candidateScans()).toBe(1);
      await fixture.panels.snapshot();
      await fixture.panels.snapshot();
      expect(fixture.candidateScans()).toBe(1);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not expose mutable rewind state through tool results or panel snapshots", async () => {
    const fixture = await createTurnRewind(false);
    try {
      const result = await fixture.tool.execute("rewind", { turns: 1 }, undefined, undefined, {} as never);
      (result.details as { target: { text: string } }).target.text = "mutated tool target";

      const firstPanel = (await fixture.panels.snapshot())[0];
      expect(firstPanel?.data).toMatchObject({
        candidates: [
          { entryId: "u1", text: "第一轮" },
          { entryId: "u2", text: "第二轮" },
        ],
        latest: { target: { entryId: "u2", text: "第二轮" } },
      });
      const firstData = firstPanel?.data as { candidates: Array<{ text: string }>; latest: { target: { text: string } } };
      firstData.candidates[0]!.text = "mutated panel candidate";
      firstData.latest.target.text = "mutated panel target";

      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        {
          data: {
            candidates: [
              { entryId: "u1", text: "第一轮" },
              { entryId: "u2", text: "第二轮" },
            ],
            latest: { target: { entryId: "u2", text: "第二轮" } },
          },
        },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("publishes explicit request, start, and finish timestamps for completed rewinds", async () => {
    const fixture = await createTurnRewind(false);
    try {
      const result = await fixture.tool.execute("timed", { turns: 1 }, undefined, undefined, {} as never);
      const details = result.details as { requestedAt: string; startedAt: string; finishedAt: string };
      expect(new Date(details.requestedAt).toISOString()).toBe(details.requestedAt);
      expect(new Date(details.startedAt).toISOString()).toBe(details.startedAt);
      expect(new Date(details.finishedAt).toISOString()).toBe(details.finishedAt);
      expect(Date.parse(details.requestedAt)).toBeLessThanOrEqual(Date.parse(details.startedAt));
      expect(Date.parse(details.startedAt)).toBeLessThanOrEqual(Date.parse(details.finishedAt));
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  // The harness never passes commandContextActions to bindExtensions, so the extension command context installs a no-op navigateTree that reports success without moving the session leaf. The rewind must therefore go through the session operation itself.
  test("navigates through the session operation rather than the unbound extension command context", async () => {
    const fixture = await createTurnRewind(false);
    try {
      await fixture.tool.execute("ui-aware", { turns: 1 }, undefined, undefined, {} as never);
      expect(fixture.navigations).toEqual([{ entryId: "u2", summarize: false }]);
      expect(fixture.rawNavigations).toEqual([{ entryId: "u2", summarize: false }]);
      expect(fixture.commandContextNavigations).toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("stops waiting for an active rewind when the plugin is disposed", async () => {
    const navigation = deferred<{ cancelled: boolean; editorText?: string }>();
    const fixture = await createTurnRewind(false, () => navigation.promise);
    const result = fixture.tool.execute("dispose", { turns: 1 }, undefined, undefined, {} as never);
    let outcome = "pending";
    void result.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    try {
      await expect.poll(() => fixture.navigations).toHaveLength(1);
      await fixture.context.fiber.dispose();
      await expect.poll(() => outcome).toBe("rejected");
    } finally {
      navigation.resolve({ cancelled: false });
      await Promise.allSettled([result]);
    }
  });

  test("declares bounded integer parameters and rejects accessor or unknown properties", async () => {
    const fixture = await createTurnRewind(false);
    let accessed = false;
    const accessor = {} as { entryId?: string };
    Object.defineProperty(accessor, "entryId", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("entryId getter executed");
      },
    });
    const symbolProperty = { turns: 1 } as Record<PropertyKey, unknown>;
    symbolProperty[Symbol("unexpected")] = true;
    try {
      expect(fixture.tool.parameters).toMatchObject({
        additionalProperties: false,
        properties: {
          turns: { type: "integer", minimum: 1, maximum: 20 },
          entryId: { type: "string", minLength: 1, maxLength: 200 },
          summarize: { type: "boolean" },
        },
      });
      expect(fixture.tool.description).toMatch(/current session branch.*queued.*agent.*settles.*preserv/iu);
      expect(fixture.tool.promptGuidelines).toEqual([
        "Use either turns or entryId, never both.",
        "Set summarize=true only when the user wants a model-generated abandoned-branch summary that may incur cost.",
      ]);
      await expect(fixture.tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(fixture.tool.execute("unknown", { turns: 1, extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(fixture.tool.execute("symbol", symbolProperty, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(fixture.tool.execute("null", null, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(fixture.tool.execute("array", [], undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(fixture.tool.execute("date", new Date(), undefined, undefined, {} as never)).rejects.toThrow(/parameters.*plain object/iu);
      expect(fixture.navigations).toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects invalid scalar parameters and ambiguous target selectors", async () => {
    const fixture = await createTurnRewind(false);
    try {
      await expect(fixture.tool.execute("turn-type", { turns: "1" }, undefined, undefined, {} as never)).rejects.toThrow(/turns.*integer/iu);
      await expect(fixture.tool.execute("turn-fraction", { turns: 1.5 }, undefined, undefined, {} as never)).rejects.toThrow(/turns.*1.*20/iu);
      await expect(fixture.tool.execute("turn-zero", { turns: 0 }, undefined, undefined, {} as never)).rejects.toThrow(/turns.*1.*20/iu);
      await expect(fixture.tool.execute("turn-high", { turns: 21 }, undefined, undefined, {} as never)).rejects.toThrow(/turns.*1.*20/iu);
      await expect(fixture.tool.execute("id-type", { entryId: 42 }, undefined, undefined, {} as never)).rejects.toThrow(/entryId.*string/iu);
      await expect(fixture.tool.execute("id-empty", { entryId: "   " }, undefined, undefined, {} as never)).rejects.toThrow(/entryId.*1-200/iu);
      await expect(fixture.tool.execute("id-long", { entryId: "x".repeat(201) }, undefined, undefined, {} as never)).rejects.toThrow(/entryId.*1-200/iu);
      await expect(fixture.tool.execute("id-nul", { entryId: "u2\0" }, undefined, undefined, {} as never)).rejects.toThrow(/entryId.*NUL/iu);
      await expect(fixture.tool.execute("summary-type", { summarize: 1 }, undefined, undefined, {} as never)).rejects.toThrow(/summarize.*boolean/iu);
      await expect(fixture.tool.execute("ambiguous", { turns: 1, entryId: "u2" }, undefined, undefined, {} as never)).rejects.toThrow(
        /turns.*entryId.*not both/iu,
      );
      expect(fixture.navigations).toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });
});
