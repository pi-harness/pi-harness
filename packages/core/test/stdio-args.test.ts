import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { PiHarnessStdioCancelledError, StdioApplication, type PiHarnessStdio } from "../src/stdio.js";
import type { PiHarnessLaunch, PiRuntimeService } from "@pi-harness/plugin-api";

function createRuntime(onPrompt?: () => void): PiRuntimeService & { prompts: string[] } {
  const prompts: string[] = [];
  const session = { messages: [{ role: "assistant", stopReason: "stop" }] } as unknown as AgentSession;
  return {
    prompts,
    session,
    sessionRuntime: { session } as unknown as AgentSessionRuntime,
    prompt(text) {
      prompts.push(text);
      onPrompt?.();
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
    dispose() {
      return Promise.resolve();
    },
  };
}

function createLaunch(args: string[]): PiHarnessLaunch {
  return { cwd: "/tmp", agentDir: "/tmp", args, requestExit() {} };
}

function createStdio(prompt: string | Error = ""): PiHarnessStdio & { output: string[]; errors: string[]; reads: number } {
  const output: string[] = [];
  const errors: string[] = [];
  const state = { reads: 0 };
  return {
    output,
    errors,
    get reads() {
      return state.reads;
    },
    readPrompt() {
      state.reads += 1;
      return prompt instanceof Error ? Promise.reject(prompt) : Promise.resolve(prompt);
    },
    writeOutput(text) {
      output.push(text);
    },
    writeError(text) {
      errors.push(text);
    },
  };
}

async function runWith(args: string[], stdinPrompt: string | Error = ""): Promise<{ code: number; prompts: string[]; errors: string[]; reads: number }> {
  const stdio = createStdio(stdinPrompt);
  const runtime = createRuntime(() => application.writeSessionEvent(assistantText("answer")));
  const application = new StdioApplication(runtime, createLaunch(args), stdio);
  const code = await application.run();
  return { code, prompts: runtime.prompts, errors: stdio.errors, reads: stdio.reads };
}

function assistantText(delta: string): AgentSessionEvent {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } } as unknown as AgentSessionEvent;
}

describe("stdio prompt arguments", () => {
  test("takes everything after the end-of-options separator literally", async () => {
    await expect(runWith(["--", "-1 plus 1"])).resolves.toMatchObject({ code: 0, prompts: ["-1 plus 1"] });
    await expect(runWith(["--", "--profile", "inside", "hello"])).resolves.toMatchObject({ code: 0, prompts: ["--profile inside hello"] });
  });

  test("falls back to stdin when the separator has nothing after it", async () => {
    await expect(runWith(["--"], "piped prompt")).resolves.toMatchObject({ code: 0, prompts: ["piped prompt"], reads: 1 });
  });

  test("rejects trailing arguments after the inline prompt option", async () => {
    const result = await runWith(["--prompt=Summarize", "the", "repo"]);

    expect(result.code).toBe(2);
    expect(result.prompts).toEqual([]);
    expect(result.errors.join("")).toMatch(/exactly one value/);
  });

  test("names a leading option-shaped argument and points at the separator", async () => {
    const result = await runWith(["--porfile", "development", "hi"]);

    expect(result.code).toBe(2);
    expect(result.errors.join("")).toBe("Unknown stdio option: --porfile; pass -- before a prompt that starts with a dash\n");
  });

  test("keeps dashes inside a positional prompt", async () => {
    await expect(runWith(["explain", "what", "tar", "-h", "prints"])).resolves.toMatchObject({ code: 0, prompts: ["explain what tar -h prints"] });
  });

  test("reports a cancelled prompt read as a signal exit instead of a usage error", async () => {
    const result = await runWith([], new PiHarnessStdioCancelledError());

    expect(result.code).toBe(130);
    expect(result.errors).toEqual([]);
  });

  test("rejects a prompt above the fixed UTF-8 byte limit", async () => {
    const result = await runWith(["--prompt", "界".repeat(349_526)]);

    expect(result.code).toBe(2);
    expect(result.prompts).toEqual([]);
    expect(result.errors).toEqual(["Prompt must be at most 1048576 UTF-8 bytes\n"]);
  });

  test("settles with signal exit while prompt input is still pending", async () => {
    let resolvePrompt: ((value: string) => void) | undefined;
    let readStarted = false;
    let aborts = 0;
    const runtime = createRuntime();
    runtime.abort = () => {
      aborts += 1;
      return Promise.resolve();
    };
    const stdio = createStdio();
    stdio.readPrompt = () => {
      readStarted = true;
      return new Promise<string>((resolve) => {
        resolvePrompt = resolve;
      });
    };
    const application = new StdioApplication(runtime, createLaunch([]), stdio);
    const controller = new AbortController();
    let outcome: number | undefined;
    const run = application.run(controller.signal).then((code) => {
      outcome = code;
      return code;
    });

    await expect.poll(() => readStarted).toBe(true);
    controller.abort();
    let expectationError: unknown;
    try {
      await expect.poll(() => outcome, { interval: 10, timeout: 200 }).toBe(130);
    } catch (error) {
      expectationError = error;
    } finally {
      resolvePrompt?.("late prompt");
      await run;
    }
    expect(aborts).toBe(1);
    if (expectationError !== undefined)
      throw expectationError instanceof Error ? expectationError : new Error("Prompt cancellation expectation failed", { cause: expectationError });
  });

  test("contains a synchronous runtime abort failure", async () => {
    const runtime = createRuntime();
    runtime.abort = () => {
      throw new Error("abort failed synchronously");
    };
    const stdio = createStdio();
    stdio.readPrompt = () => new Promise<string>(() => {});
    const application = new StdioApplication(runtime, createLaunch([]), stdio);
    const controller = new AbortController();
    const run = application.run(controller.signal);

    controller.abort();
    await expect(run).resolves.toBe(130);
  });

  test("returns signal exit when shutdown arrives during the agent request", async () => {
    const runtime = createRuntime();
    let settlePrompt: (() => void) | undefined;
    runtime.prompt = () =>
      new Promise<void>((resolve) => {
        settlePrompt = resolve;
      });
    runtime.abort = () => {
      settlePrompt?.();
      return Promise.resolve();
    };
    const stdio = createStdio();
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const controller = new AbortController();
    const run = application.run(controller.signal);

    await expect.poll(() => settlePrompt).toBeTypeOf("function");
    controller.abort();
    await expect(run).resolves.toBe(130);
    expect(stdio.errors).toEqual([]);
  });

  test("returns signal exit when runtime abort rejects the agent request", async () => {
    const runtime = createRuntime();
    let rejectPrompt: ((reason: unknown) => void) | undefined;
    runtime.prompt = () =>
      new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      });
    runtime.abort = () => {
      rejectPrompt?.(new Error("agent aborted for shutdown"));
      return Promise.resolve();
    };
    const stdio = createStdio();
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const controller = new AbortController();
    const run = application.run(controller.signal);

    await expect.poll(() => rejectPrompt).toBeTypeOf("function");
    controller.abort();
    await expect(run).resolves.toBe(130);
    expect(stdio.errors).toEqual([]);
  });

  test("settles on shutdown even when runtime abort cannot settle the agent request", async () => {
    const runtime = createRuntime();
    let settlePrompt: (() => void) | undefined;
    runtime.prompt = () =>
      new Promise<void>((resolve) => {
        settlePrompt = resolve;
      });
    runtime.abort = () => {
      throw new Error("abort unavailable");
    };
    const stdio = createStdio();
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const controller = new AbortController();
    let outcome: number | undefined;
    const run = application.run(controller.signal).then((code) => {
      outcome = code;
      return code;
    });

    await expect.poll(() => settlePrompt).toBeTypeOf("function");
    controller.abort();
    let expectationError: unknown;
    try {
      await expect.poll(() => outcome, { interval: 10, timeout: 200 }).toBe(130);
    } catch (error) {
      expectationError = error;
    } finally {
      settlePrompt?.();
      await run;
    }
    if (expectationError !== undefined)
      throw expectationError instanceof Error ? expectationError : new Error("Agent cancellation expectation failed", { cause: expectationError });
  });
});

describe("stdio session events", () => {
  test("ignores a hostile event type accessor", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    let accessed = false;
    const event: Record<string, unknown> = {};
    Object.defineProperty(event, "type", {
      get() {
        accessed = true;
        throw new Error("type getter executed");
      },
    });

    expect(() => application.writeSessionEvent(event as never)).not.toThrow();
    expect(accessed).toBe(false);
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);
  });

  test("ignores hostile assistant update accessors", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    const accessed: string[] = [];
    const outer = { type: "message_update" };
    Object.defineProperty(outer, "assistantMessageEvent", {
      get() {
        accessed.push("assistantMessageEvent");
        throw new Error("assistantMessageEvent getter executed");
      },
    });
    const inner = { type: "text_delta" };
    Object.defineProperty(inner, "delta", {
      get() {
        accessed.push("delta");
        throw new Error("delta getter executed");
      },
    });

    expect(() => application.writeSessionEvent(outer as never)).not.toThrow();
    expect(() => application.writeSessionEvent({ type: "message_update", assistantMessageEvent: inner } as never)).not.toThrow();
    expect(accessed).toEqual([]);
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);
  });

  test("reports tool activity on stderr and keeps assistant text on stdout", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    application.writeSessionEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "rm -rf build" } });
    application.writeSessionEvent({ type: "tool_execution_end", toolCallId: "1", toolName: "bash", result: {}, isError: true });
    application.writeSessionEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } } as unknown as AgentSessionEvent);
    await run;

    expect(stdio.errors.join("")).toBe('> bash {"command":"rm -rf build"}\n! bash failed\n');
    expect(stdio.output.join("")).toContain("done");
  });

  test("truncates an oversized tool argument summary to a single bounded line", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    application.writeSessionEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "write", args: { text: "x".repeat(5_000) } });
    application.writeSessionEvent(assistantText("done"));
    await run;

    const line = stdio.errors.join("");
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
    expect(line.length).toBeLessThan(160);
    expect(line).toContain("...");
  });

  test("summarizes tool arguments without invoking accessors or toJSON", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    const accessed: string[] = [];
    const args: Record<string, unknown> = { command: "safe" };
    for (const key of ["secret", "toJSON"]) {
      Object.defineProperty(args, key, {
        enumerable: true,
        get() {
          accessed.push(key);
          throw new Error(`${key} getter executed`);
        },
      });
    }

    expect(() => application.writeSessionEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "write", args } as never)).not.toThrow();
    expect(accessed).toEqual([]);
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);
    expect(stdio.errors.join("")).toContain("[Accessor]");
  });

  test("sanitizes NUL and line breaks in a string tool argument", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();

    application.writeSessionEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "custom", args: "bad\0arg\nnext" });
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);

    expect(stdio.errors).toEqual(["> custom bad�arg next\n"]);
  });

  test("ignores hostile tool event field accessors", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    const accessed: string[] = [];
    const toolStart = { type: "tool_execution_start" };
    const toolEnd = { type: "tool_execution_end", toolName: "write" };
    for (const [target, key] of [
      [toolStart, "toolName"],
      [toolStart, "args"],
      [toolEnd, "isError"],
    ] as const) {
      Object.defineProperty(target, key, {
        get() {
          accessed.push(key);
          throw new Error(`${key} getter executed`);
        },
      });
    }

    expect(() => application.writeSessionEvent(toolStart as never)).not.toThrow();
    expect(() => application.writeSessionEvent(toolEnd as never)).not.toThrow();
    expect(accessed).toEqual([]);
    expect(stdio.errors).toEqual([]);
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);
  });

  test("sanitizes and bounds tool names in stderr diagnostics", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();

    application.writeSessionEvent({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: `bad\0\nname-${"x".repeat(1_000)}`,
      args: {},
    });
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);

    const diagnostic = stdio.errors.join("");
    expect(diagnostic.split("\n").filter(Boolean)).toHaveLength(1);
    expect(diagnostic).not.toContain("\0");
    expect(diagnostic.length).toBeLessThanOrEqual(140);
  });

  test("ignores hostile retry diagnostic accessors", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    const accessed: string[] = [];
    const event = { type: "auto_retry_start" };
    for (const key of ["errorMessage", "attempt", "maxAttempts"]) {
      Object.defineProperty(event, key, {
        get() {
          accessed.push(key);
          throw new Error(`${key} getter executed`);
        },
      });
    }

    expect(() => application.writeSessionEvent(event as never)).not.toThrow();
    expect(accessed).toEqual([]);
    expect(stdio.errors).toEqual([]);
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);
  });

  test("writes a bounded single-line retry diagnostic for a valid retry event", async () => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();

    application.writeSessionEvent({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1_000,
      errorMessage: `provider\0 failed\n${"x".repeat(3_000)}`,
    });
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);

    const diagnostic = stdio.errors.join("");
    expect(diagnostic).toMatch(/^Retrying after provider� failed x+… \(attempt 2\/3\)\n$/u);
    expect(diagnostic.length).toBeLessThanOrEqual(2_090);
  });

  test.each([
    [0, 3],
    [4, 3],
    [1.5, 3],
    [1, Number.NaN],
  ])("ignores an invalid retry counter pair %s/%s", async (attempt, maxAttempts) => {
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();

    application.writeSessionEvent({ type: "auto_retry_start", attempt, maxAttempts, delayMs: 1_000, errorMessage: "failed" });
    application.writeSessionEvent(assistantText("done"));
    await expect(run).resolves.toBe(0);

    expect(stdio.errors).toEqual([]);
  });
});

describe("stdio run outcome", () => {
  function createApplication(messages: unknown[]): { application: StdioApplication; stdio: ReturnType<typeof createStdio> } {
    const runtime = createRuntime();
    (runtime.session as unknown as { messages: unknown[] }).messages = messages;
    const stdio = createStdio("prompt");
    return { application: new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio), stdio };
  }

  test("separates assistant turns interrupted by a tool call", async () => {
    const { application, stdio } = createApplication([{ role: "assistant", stopReason: "stop" }]);
    const run = application.run();
    application.writeSessionEvent(assistantText("Let me look."));
    application.writeSessionEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} });
    application.writeSessionEvent(assistantText("Now I will fix it."));
    await run;

    expect(stdio.output.join("")).toBe("Let me look.\nNow I will fix it.\n");
  });

  test("reports a hostile prompt rejection without inspecting or coercing it", async () => {
    const accessed: PropertyKey[] = [];
    const hostile = new Proxy(
      {},
      {
        get(_target, key) {
          accessed.push(key);
          throw new Error(`prompt error property read: ${String(key)}`);
        },
        getPrototypeOf() {
          accessed.push("prototype");
          throw new Error("prompt error prototype inspected");
        },
      },
    );
    const runtime = createRuntime();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- provider code can reject with an arbitrary foreign value
    runtime.prompt = () => Promise.reject(hostile);
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);

    await expect(application.run()).resolves.toBe(1);
    expect(accessed).toEqual([]);
    expect(stdio.errors).toEqual(["Agent request failed\n"]);
  });

  test("reports a response truncated by the model output limit as a failure", async () => {
    const { application, stdio } = createApplication([{ role: "assistant", stopReason: "length" }]);
    const run = application.run();
    application.writeSessionEvent(assistantText("half a sen"));

    await expect(run).resolves.toBe(1);
    expect(stdio.errors.join("")).toContain("truncated");
  });

  test("reads the last assistant message even when a tool result follows it", async () => {
    const { application, stdio } = createApplication([{ role: "assistant", stopReason: "error", errorMessage: "provider exploded" }, { role: "toolResult" }]);
    const run = application.run();
    application.writeSessionEvent(assistantText("partial"));

    await expect(run).resolves.toBe(1);
    expect(stdio.errors.join("")).toContain("provider exploded");
  });

  test("inspects final session messages without proxy property reads", async () => {
    const runtime = createRuntime();
    const propertyReads: PropertyKey[] = [];
    const messages = new Proxy([{ role: "assistant", stopReason: "stop" }], {
      get(_target, key) {
        propertyReads.push(key);
        throw new Error(`messages property read: ${String(key)}`);
      },
    });
    (runtime.session as unknown as { messages: unknown }).messages = messages;
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    application.writeSessionEvent(assistantText("done"));

    await expect(run).resolves.toBe(0);
    expect(propertyReads).toEqual([]);
  });

  test("does not coerce a hostile final assistant error message", async () => {
    const accessed: PropertyKey[] = [];
    const hostile = new Proxy(
      {},
      {
        get(_target, key) {
          accessed.push(key);
          throw new Error(`error property read: ${String(key)}`);
        },
      },
    );
    const { application, stdio } = createApplication([{ role: "assistant", stopReason: "error", errorMessage: hostile }]);
    const run = application.run();
    application.writeSessionEvent(assistantText("partial"));

    await expect(run).resolves.toBe(1);
    expect(accessed).toEqual([]);
    expect(stdio.errors.join("")).toContain("Request error");
  });

  test("contains a failure from the upstream session messages getter", async () => {
    const runtime = createRuntime();
    Object.defineProperty(runtime.session, "messages", {
      get() {
        throw new Error("session messages unavailable");
      },
    });
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    const run = application.run();
    application.writeSessionEvent(assistantText("partial"));

    await expect(run).resolves.toBe(1);
    expect(stdio.errors.join("")).toContain("session messages unavailable");
  });

  test("does not report success without a final assistant message", async () => {
    const { application, stdio } = createApplication([{ role: "toolResult" }]);
    const run = application.run();
    application.writeSessionEvent(assistantText("partial"));

    await expect(run).resolves.toBe(1);
    expect(stdio.output.join("")).toBe("partial\n");
    expect(stdio.errors.join("")).toContain("final assistant response");
  });

  test("does not report success for an unreadable final stop reason", async () => {
    let accessed = false;
    const message = { role: "assistant" };
    Object.defineProperty(message, "stopReason", {
      get() {
        accessed = true;
        throw new Error("stop reason getter executed");
      },
    });
    const { application, stdio } = createApplication([message]);
    const run = application.run();
    application.writeSessionEvent(assistantText("partial"));

    await expect(run).resolves.toBe(1);
    expect(accessed).toBe(false);
    expect(stdio.errors.join("")).toContain("stop reason");
  });

  test("does not report success for a run that produced no assistant text", async () => {
    const { application, stdio } = createApplication([{ role: "assistant", stopReason: "stop" }]);

    await expect(application.run()).resolves.toBe(1);
    expect(stdio.output).toEqual([]);
    expect(stdio.errors.join("")).toContain("no output");
  });

  test("does not count an empty assistant delta as output", async () => {
    const { application, stdio } = createApplication([{ role: "assistant", stopReason: "stop" }]);
    const run = application.run();
    application.writeSessionEvent(assistantText(""));

    await expect(run).resolves.toBe(1);
    expect(stdio.output).toEqual([]);
    expect(stdio.errors.join("")).toContain("no output");
  });

  test("does not append a second newline when assistant output already ends with one", async () => {
    const { application, stdio } = createApplication([{ role: "assistant", stopReason: "stop" }]);
    const run = application.run();
    application.writeSessionEvent(assistantText("done\n"));

    await expect(run).resolves.toBe(0);
    expect(stdio.output.join("")).toBe("done\n");
  });

  test("does not reuse assistant-output state across sequential runs", async () => {
    let calls = 0;
    const runtime = createRuntime();
    const stdio = createStdio("prompt");
    const application = new StdioApplication(runtime, createLaunch(["--prompt", "hi"]), stdio);
    runtime.prompt = () => {
      calls += 1;
      if (calls === 1) application.writeSessionEvent(assistantText("first response"));
      return Promise.resolve();
    };

    await expect(application.run()).resolves.toBe(0);
    await expect(application.run()).resolves.toBe(1);
    expect(stdio.output.join("")).toBe("first response\n");
    expect(stdio.errors.join("")).toContain("no output");
  });
});
