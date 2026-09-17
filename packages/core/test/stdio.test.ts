import type { Context } from "@deepseek-ai/cordis";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiHarnessLaunch, PiRuntimeService } from "@pi-harness/plugin-api";
import { afterEach, describe, expect, test } from "vitest";
import { provideStdioContext, StdioApplication, type PiHarnessStdio } from "../src/stdio.js";
import stdioPlugin from "../src/plugins/stdio.js";
import { createTestRuntimeContext } from "../src/test-harness.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

function captureStdio(input: string): PiHarnessStdio & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    readPrompt() {
      return Promise.resolve(input);
    },
    writeOutput(text) {
      output.push(text);
    },
    writeError(text) {
      errors.push(text);
    },
  };
}

// A marker is written from the session-event handler while a run is in flight, so the run is driven by a stub runtime that hands control back at exactly that point and then ends on an assistant message that stopped normally.
async function runWithSessionEvents(events: readonly unknown[]): Promise<string[]> {
  const stdio = captureStdio("marker prompt");
  const runtime = {
    session: { messages: [{ role: "assistant", stopReason: "stop" }] },
    prompt() {
      for (const event of events) application.writeSessionEvent(event as AgentSessionEvent);
      application.writeSessionEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done\n" } } as AgentSessionEvent);
      return Promise.resolve();
    },
    abort: () => Promise.resolve(),
  } as unknown as PiRuntimeService;
  const launch: PiHarnessLaunch = { cwd: "/workspace", agentDir: "/workspace/agent", args: ["--prompt", "marker"], requestExit() {} };
  const application = new StdioApplication(runtime, launch, stdio);

  expect(await application.run()).toBe(0);
  expect(stdio.output.join("")).toBe("done\n");
  return stdio.errors;
}

describe("stdio tool markers", () => {
  test("names the file a write touched before spending the line on its content", async () => {
    const errors = await runWithSessionEvents([
      { type: "tool_execution_start", toolName: "write", args: { content: "Lorem ipsum dolor sit amet, ".repeat(20), path: "/workspace/vnote.txt" } },
    ]);

    expect(errors[0]).toMatch(/^> write \{"path":"\/workspace\/vnote\.txt"/u);
    // The bulk argument still takes whatever budget is left, so the reader sees both the target and a sample of what was written.
    expect(errors[0]).toContain("Lorem ipsum");
    expect(errors[0]).toMatch(/\.\.\.\n$/u);
  });

  test("keeps the model's own order for arguments the harness does not recognize", async () => {
    const errors = await runWithSessionEvents([
      { type: "tool_execution_start", toolName: "edit", args: { newText: "b", zeta: 1, path: "/workspace/a.ts", alpha: 2 } },
    ]);

    expect(errors).toEqual([`> edit {"path":"/workspace/a.ts","zeta":1,"alpha":2,"newText":"b"}\n`]);
  });

  test("reports why a tool failed instead of naming it and stopping there", async () => {
    const errors = await runWithSessionEvents([
      { type: "tool_execution_start", toolName: "bash", args: { command: "cat /workspace/missing" } },
      { type: "tool_execution_end", toolName: "bash", isError: true, result: { content: "cat: /workspace/missing: No such file or directory" } },
    ]);

    expect(errors[1]).toBe("! bash: cat: /workspace/missing: No such file or directory\n");
  });

  test("reads a failure reported as content blocks", async () => {
    const errors = await runWithSessionEvents([
      { type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "exit status 1" }, { type: "image" }] } },
    ]);

    expect(errors).toEqual(["! bash: exit status 1\n"]);
  });

  test("falls back to the bare wording when the failure carries no readable text", async () => {
    const errors = await runWithSessionEvents([{ type: "tool_execution_end", toolName: "bash", isError: true, result: { details: { exitCode: 1 } } }]);

    expect(errors).toEqual(["! bash failed\n"]);
  });

  test("bounds and neutralizes an untrusted failure reason", async () => {
    const errors = await runWithSessionEvents([
      { type: "tool_execution_end", toolName: "bash", isError: true, result: { content: `\u001B[2Jcleared\n${"x".repeat(3_000)}` } },
    ]);

    expect(errors[0]?.split("\n").filter(Boolean)).toHaveLength(1);
    expect(errors[0]?.replace(/\n$/u, "")).not.toMatch(/[\p{Cc}\p{Bidi_Control}]/u);
    expect(errors[0]?.length).toBeLessThanOrEqual(2_100);
  });

  test("writes nothing for a tool that succeeded", async () => {
    const errors = await runWithSessionEvents([{ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: "ok" } }]);

    expect(errors).toEqual([]);
  });
});

describe("stdio application plugin", () => {
  test("rejects a non-object configuration before providing the application", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    provideStdioContext(context, captureStdio(""));
    let activationError: unknown;
    try {
      await context.plugin(stdioPlugin, 42 as never);
    } catch (error) {
      activationError = error;
    }

    expect(activationError).toBeInstanceOf(Error);
    expect(context.get("piApplication")).toBeUndefined();
  });

  test("rejects unknown configuration before providing the application", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    provideStdioContext(context, captureStdio(""));

    await expect(context.plugin(stdioPlugin, { unexpected: true })).rejects.toThrow(/Unknown pi-stdio config keys: unexpected/u);
    expect(context.get("piApplication")).toBeUndefined();
  });

  test("reads one prompt and streams the assistant response", async () => {
    const { context, faux } = await createTestRuntimeContext([fauxAssistantMessage("stdio response")]);
    contexts.push(context);
    const stdio = captureStdio("user prompt");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    const exitCode = await context.piApplication.run();

    expect(exitCode).toBe(0);
    expect(stdio.output.join("")).toBe("stdio response\n");
    expect(stdio.errors).toEqual([]);
    expect(faux.state.callCount).toBe(1);
    expect(context.piRuntime.session.messages.some((message) => message.role === "user")).toBe(true);
  });

  test("returns a usage error without calling the model for an empty prompt", async () => {
    const { context, faux } = await createTestRuntimeContext([fauxAssistantMessage("unused")]);
    contexts.push(context);
    const stdio = captureStdio("   ");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    const exitCode = await context.piApplication.run();

    expect(exitCode).toBe(2);
    expect(stdio.errors.join("")).toMatch(/prompt is empty/i);
    expect(faux.state.callCount).toBe(0);
  });

  test("reports a settled provider error as a failed application run", async () => {
    const { context } = await createTestRuntimeContext([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);
    contexts.push(context);
    const stdio = captureStdio("trigger error");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    const exitCode = await context.piApplication.run();

    expect(exitCode).toBe(1);
    expect(stdio.errors.join("")).toContain("provider failed");
  });

  test("neutralizes terminal escape sequences in a provider error message", async () => {
    const errorMessage = "Upstream error: \u001B]52;c;cm0gLXJmIC8=\u0007 then \u001B[2J";
    const { context } = await createTestRuntimeContext([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
    contexts.push(context);
    const stdio = captureStdio("trigger error");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    const exitCode = await context.piApplication.run();

    expect(exitCode).toBe(1);
    expect(stdio.errors).toHaveLength(1);
    expect(stdio.errors[0]).toContain("Upstream error:");
    expect(stdio.errors[0]?.replace(/\n$/u, "")).not.toMatch(/[\p{Cc}\p{Bidi_Control}]/u);
  });

  test("keeps a zero-width joiner emoji sequence intact in a provider error message", async () => {
    const errorMessage = "Upstream error: \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} crashed";
    const { context } = await createTestRuntimeContext([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
    contexts.push(context);
    const stdio = captureStdio("trigger error");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    const exitCode = await context.piApplication.run();

    expect(exitCode).toBe(1);
    expect(stdio.errors).toEqual([`${errorMessage}\n`]);
  });

  test("reports non-error resource diagnostics instead of dropping them", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    (context.piResources.diagnostics as unknown as Array<{ type: "warning"; message: string }>).push({ type: "warning", message: "extension warning" });
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);

    await context.plugin(stdioPlugin);

    expect(stdio.errors).toEqual(["Resource warning: extension warning\n"]);
  });

  test("bounds resource diagnostics and reports omitted entries", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    const diagnostics = context.piResources.diagnostics as unknown as Array<{ type: "warning"; message: string }>;
    for (let index = 0; index < 110; index += 1) diagnostics.push({ type: "warning", message: `warning-${index}` });
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);

    await context.plugin(stdioPlugin);

    expect(stdio.errors).toHaveLength(101);
    expect(stdio.errors[0]).toBe("Resource warning: warning-0\n");
    expect(stdio.errors[99]).toBe("Resource warning: warning-99\n");
    expect(stdio.errors[100]).toBe("Resource diagnostics: 10 additional entries omitted\n");
  });

  test("ignores hostile resource diagnostic accessors during activation", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    const accessed: string[] = [];
    const diagnostic: Record<string, unknown> = {};
    for (const key of ["type", "message"]) {
      Object.defineProperty(diagnostic, key, {
        get() {
          accessed.push(key);
          throw new Error(`${key} getter executed`);
        },
      });
    }
    (context.piResources.diagnostics as unknown as unknown[]).push(diagnostic);
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);

    await context.plugin(stdioPlugin);
    expect(accessed).toEqual([]);
    expect(stdio.errors).toEqual([]);
  });

  test("sanitizes and bounds resource diagnostics", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    (context.piResources.diagnostics as unknown as Array<{ type: string; message: string }>).push({
      type: `warning\0\n${"t".repeat(100)}`,
      message: `unsafe\0\n${"m".repeat(3_000)}`,
    });
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);

    await context.plugin(stdioPlugin);

    expect(stdio.errors).toHaveLength(1);
    expect(stdio.errors[0]?.split("\n").filter(Boolean)).toHaveLength(1);
    expect(stdio.errors[0]).not.toContain("\0");
    expect(stdio.errors[0]?.length).toBeLessThanOrEqual(2_100);
  });

  test("ignores hostile extension error accessors", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);
    const accessed: string[] = [];
    const error: Record<string, unknown> = {};
    for (const key of ["extensionPath", "error"]) {
      Object.defineProperty(error, key, {
        get() {
          accessed.push(key);
          throw new Error(`${key} getter executed`);
        },
      });
    }

    expect(() => context.emit("pi/extension-error", error as never)).not.toThrow();
    expect(accessed).toEqual([]);
    expect(stdio.errors).toEqual([]);
  });

  test("uses a stable fallback for an extension failure without a safe message", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    context.emit("pi/extension-error", { extensionPath: "plugin.ts", event: "load", error: {} } as never);

    expect(stdio.errors).toEqual(["Extension error (plugin.ts): Unknown extension failure\n"]);
  });

  test("sanitizes and bounds extension failure paths and messages", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    context.emit("pi/extension-error", {
      extensionPath: `plugin\0\n${"p".repeat(1_000)}`,
      event: "load",
      error: `failure\0\n${"m".repeat(3_000)}`,
    });

    expect(stdio.errors).toHaveLength(1);
    expect(stdio.errors[0]?.split("\n").filter(Boolean)).toHaveLength(1);
    expect(stdio.errors[0]).not.toContain("\0");
    expect(stdio.errors[0]?.length).toBeLessThanOrEqual(2_590);
  });

  test("neutralizes terminal escape sequences in resource diagnostics and extension failures", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    (context.piResources.diagnostics as unknown as Array<{ type: "warning"; message: string }>).push({
      type: "warning",
      message: "loaded \u001B]52;c;cm0gLXJmIC8=\u0007 skill",
    });
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    context.emit("pi/extension-error", { extensionPath: "plugin\u001B[2J.ts", event: "load", error: "boom \u001B[1;1H\u009Bm \u202Espoofed" });

    expect(stdio.errors).toHaveLength(2);
    expect(stdio.errors[0]).toContain("Resource warning:");
    expect(stdio.errors[1]).toContain("Extension error");
    for (const line of stdio.errors) expect(line.replace(/\n$/u, "")).not.toMatch(/[\p{Cc}\p{Bidi_Control}]/u);
  });

  test("keeps a zero-width joiner emoji sequence intact in an extension failure", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);

    context.emit("pi/extension-error", { extensionPath: "plugin.ts", event: "load", error: "\u{1F468}\u{200D}\u{1F4BB} crashed" });

    expect(stdio.errors).toEqual(["Extension error (plugin.ts): \u{1F468}\u{200D}\u{1F4BB} crashed\n"]);
  });

  test("removes session and extension listeners when disposed", async () => {
    const { context } = await createTestRuntimeContext([]);
    contexts.push(context);
    const stdio = captureStdio("");
    provideStdioContext(context, stdio);
    await context.plugin(stdioPlugin);
    await context.fiber.dispose();
    let inspections = 0;
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          inspections += 1;
          return undefined;
        },
      },
    );

    context.emit("pi/session-event", hostile as never);
    context.emit("pi/extension-error", hostile as never);

    expect(inspections).toBe(0);
    expect(stdio.errors).toEqual([]);
    expect(context.get("piApplication")).toBeUndefined();
  });
});
