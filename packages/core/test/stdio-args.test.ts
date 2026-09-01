import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { PiHarnessStdioCancelledError, StdioApplication, type PiHarnessStdio } from "../src/stdio.js";
import type { PiHarnessLaunch, PiRuntimeService } from "../src/services.js";

function createRuntime(): PiRuntimeService & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    session: { messages: [] } as unknown as AgentSession,
    prompt(text) {
      prompts.push(text);
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

function createStdio(prompt: string | Error = ""): PiHarnessStdio & { errors: string[]; reads: number } {
  const errors: string[] = [];
  const state = { reads: 0 };
  return {
    errors,
    get reads() {
      return state.reads;
    },
    readPrompt() {
      state.reads += 1;
      return prompt instanceof Error ? Promise.reject(prompt) : Promise.resolve(prompt);
    },
    writeOutput() {},
    writeError(text) {
      errors.push(text);
    },
  };
}

async function runWith(args: string[], stdinPrompt: string | Error = ""): Promise<{ code: number; prompts: string[]; errors: string[]; reads: number }> {
  const runtime = createRuntime();
  const stdio = createStdio(stdinPrompt);
  const code = await new StdioApplication(runtime, createLaunch(args), stdio).run();
  return { code, prompts: runtime.prompts, errors: stdio.errors, reads: stdio.reads };
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
});
