import type { Context } from "@deepseek-ai/cordis";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, test } from "vitest";
import { provideStdioContext, type PiHarnessStdio } from "../src/stdio.js";
import stdioPlugin from "../src/plugins/stdio.js";
import { createTestRuntimeContext } from "./runtime-fixture.js";

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
});
