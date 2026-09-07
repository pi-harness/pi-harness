import type { Context } from "@deepseek-ai/cordis";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, test } from "vitest";
import { provideStdioContext, type PiHarnessStdio } from "../src/stdio.js";
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
