import { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import changeVerifierPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

async function createVerifier(options?: {
  reviewError?: boolean;
  testError?: boolean;
  reviewStatus?: unknown;
  testDurationMs?: unknown;
  testExitCode?: unknown;
  afterReview?: () => void;
  afterTests?: () => void;
}): Promise<{
  context: Context;
  panels: PiPluginUiRegistry;
  testScripts: string[];
  tools: PiToolRegistry;
}> {
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const testScripts: string[] = [];
  const tools = new PiToolRegistry();
  tools.register(
    defineTool({
      name: "review_changes",
      label: "Review fixture",
      description: "Review fixture",
      parameters: Type.Object({}),
      execute() {
        options?.afterReview?.();
        return Promise.resolve({
          content: [{ type: "text" as const, text: "reviewed" }],
          isError: options?.reviewError,
          details: { status: options?.reviewStatus ?? "pass", findings: [] },
        });
      },
    }),
  );
  tools.register(
    defineTool({
      name: "run_project_tests",
      label: "Test fixture",
      description: "Test fixture",
      parameters: Type.Object({ script: Type.Optional(Type.String()) }),
      execute(_toolCallId, params) {
        testScripts.push(params.script ?? "test");
        options?.afterTests?.();
        return Promise.resolve({
          content: [{ type: "text" as const, text: "tested" }],
          isError: options?.testError,
          details: { exitCode: options?.testExitCode ?? 0, durationMs: options?.testDurationMs ?? 10 },
        });
      },
    }),
  );
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(changeVerifierPlugin);
  return { context, panels, testScripts, tools };
}

function verifierTool(tools: PiToolRegistry) {
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "verify_change_gate");
  if (tool === undefined) throw new Error("verify_change_gate was not registered");
  return tool;
}

describe("change-verifier", () => {
  test("clears old success while a new provider call is running", async () => {
    let observed: ReturnType<PiPluginUiRegistry["snapshot"]> | undefined;
    const { context, panels, tools } = await createVerifier({
      afterReview: () => {
        observed = panels.snapshot();
      },
    });
    try {
      const verify = verifierTool(tools);
      await verify.execute("first", {}, undefined, undefined, {} as never);
      await verify.execute("second", {}, undefined, undefined, {} as never);
      expect((await observed)?.[0]?.data).toMatchObject({ status: "running", latest: null, lastError: null, runs: 1 });
    } finally {
      await context.fiber.dispose();
    }
  });

  test.each(["review", "tests"] as const)("clears prior pass when the next %s provider throws and recovers", async (stage) => {
    let fail = false;
    const reject = () => {
      if (fail) throw new Error("Synthetic provider failed");
    };
    const { context, tools, panels } = await createVerifier(stage === "review" ? { afterReview: reject } : { afterTests: reject });
    try {
      const verify = verifierTool(tools);
      await verify.execute("pass", {}, undefined, undefined, {} as never);
      fail = true;
      await expect(verify.execute("fail", {}, undefined, undefined, {} as never)).rejects.toThrow("Synthetic provider failed");
      expect((await panels.snapshot())[0]?.data).toMatchObject({ runs: 1, latest: null, status: "failed", lastError: "Synthetic provider failed" });
      fail = false;
      await verify.execute("recovery", {}, undefined, undefined, {} as never);
      expect((await panels.snapshot())[0]?.data).toMatchObject({ runs: 2, latest: { status: "pass" }, status: "completed", lastError: null });
    } finally {
      await context.fiber.dispose();
    }
  });

  test.each(["review", "tests"] as const)("does not pass an explicit %s tool error with success-shaped details", async (stage) => {
    const { context, tools, panels } = await createVerifier(stage === "review" ? { reviewError: true } : { testError: true });
    try {
      const result = await verifierTool(tools).execute("provider-error", {}, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ status: "fail" });
      expect((await panels.snapshot())[0]?.data).toMatchObject({ latest: { status: "fail" } });
    } finally {
      await context.fiber.dispose();
    }
  });
  test.each(["review", "tests"] as const)("rejects session replacement after %s before publishing a gate", async (stage) => {
    const session = (id: string) => ({ sessionId: id, sessionManager: { getCwd: () => `/synthetic/${id}` } });
    const runtime = { session: session("a") };
    const replace = () => {
      runtime.session = session("b");
    };
    const { context, panels, tools, testScripts } = await createVerifier(stage === "review" ? { afterReview: replace } : { afterTests: replace });
    context.provide("piRuntime", runtime as never);
    try {
      await expect(verifierTool(tools).execute("switch", {}, undefined, undefined, {} as never)).rejects.toThrow("Session or workspace changed");
      expect(testScripts).toEqual(stage === "review" ? [] : ["test"]);
      expect((await panels.snapshot())[0]?.data).toEqual({ runs: 0, latest: null, status: "idle", lastError: null });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("clears gate state when the active session changes", async () => {
    const { context, panels, tools } = await createVerifier();
    const session = (id: string) => ({ sessionId: id, sessionManager: { getCwd: () => `/synthetic/${id}` } });
    const runtime = { session: session("a") };
    context.provide("piRuntime", runtime as never);
    try {
      await verifierTool(tools).execute("a", {}, undefined, undefined, {} as never);
      runtime.session = session("b");
      expect((await panels.snapshot())[0]?.data).toEqual({ runs: 0, latest: null, status: "idle", lastError: null });
    } finally {
      await context.fiber.dispose();
    }
  });

  test.each(["review", "tests"] as const)("rejects cancellation after %s without publishing a successful gate", async (stage) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("User cancelled verification"));
    const { context, panels, tools, testScripts } = await createVerifier(stage === "review" ? { afterReview: abort } : { afterTests: abort });
    try {
      await expect(verifierTool(tools).execute("cancelled", {}, controller.signal, undefined, {} as never)).rejects.toThrow("User cancelled verification");
      expect(testScripts).toEqual(stage === "review" ? [] : ["test"]);
      expect((await panels.snapshot())[0]?.data).toEqual({ runs: 0, latest: null, status: "cancelled", lastError: "User cancelled verification" });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("declares the verification script length bounds", async () => {
    const { context, tools } = await createVerifier();
    try {
      expect(verifierTool(tools).parameters).toMatchObject({
        properties: { script: { type: "string", minLength: 1, maxLength: 128 } },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("normalizes missing scripts and rejects malformed scripts before invoking the test provider", async () => {
    const { context, testScripts, tools } = await createVerifier();
    const verify = verifierTool(tools);
    try {
      await expect(verify.execute("null", null, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { script: "test" } });
      await expect(verify.execute("blank", { script: "   " }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { script: "test" } });
      await expect(verify.execute("type", { script: 7 }, undefined, undefined, {} as never)).rejects.toThrow(/script must be a string/iu);
      await expect(verify.execute("length", { script: "x".repeat(129) }, undefined, undefined, {} as never)).rejects.toThrow(/between 1 and 128/iu);
      expect(testScripts).toEqual(["test", "test"]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("fails closed when the review provider returns an unknown status", async () => {
    const { context, tools } = await createVerifier({ reviewStatus: "unknown" });
    try {
      await expect(verifierTool(tools).execute("verify", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { status: "fail", review: { status: "error" } },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("fails closed and normalizes non-finite test provider metrics", async () => {
    const { context, tools } = await createVerifier({ testExitCode: Number.NaN, testDurationMs: Number.POSITIVE_INFINITY });
    try {
      await expect(verifierTool(tools).execute("verify", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { status: "fail", tests: { exitCode: 1, durationMs: 0 } },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("cancels an in-flight verification when the plugin is disposed", async () => {
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    let reviewAborted = false;
    let rejectReview: ((error: Error) => void) | undefined;
    tools.register(
      defineTool({
        name: "review_changes",
        label: "Review fixture",
        description: "Review fixture",
        parameters: Type.Object({}),
        execute(_toolCallId, _params, signal) {
          return new Promise((_resolve, reject) => {
            rejectReview = reject;
            signal?.addEventListener(
              "abort",
              () => {
                reviewAborted = true;
                const reason: unknown = signal.reason;
                reject(reason instanceof Error ? reason : new Error("review aborted"));
              },
              { once: true },
            );
          });
        },
      }),
    );
    tools.register(
      defineTool({
        name: "run_project_tests",
        label: "Test fixture",
        description: "Test fixture",
        parameters: Type.Object({ script: Type.Optional(Type.String()) }),
        execute() {
          return Promise.resolve({ content: [{ type: "text" as const, text: "tested" }], details: { exitCode: 0, durationMs: 1 } });
        },
      }),
    );
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(changeVerifierPlugin);
    let execution: Promise<unknown> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
      execution = verifierTool(tools).execute("verify", {}, undefined, undefined, {} as never);

      await context.fiber.dispose();
      const outcome = await Promise.race([
        execution.then(
          () => new Error("Verification unexpectedly succeeded"),
          (error: unknown) => error,
        ),
        new Promise<string>((resolve) => {
          fallback = setTimeout(() => resolve("Verification remained pending"), 500);
        }),
      ]);

      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toMatch(/disposed|cancelled/iu);
      expect(reviewAborted).toBe(true);
      expect(tools.snapshot().customTools.map((tool) => tool.name)).toEqual(["review_changes", "run_project_tests"]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      if (fallback !== undefined) clearTimeout(fallback);
      rejectReview?.(new Error("test cleanup"));
      await context.fiber.dispose();
      await execution?.catch(() => undefined);
    }
  });

  test("does not expose mutable gate state and preserves it after validation failures", async () => {
    const { context, panels, tools } = await createVerifier();
    const verify = verifierTool(tools);
    try {
      const result = await verify.execute("verify", { script: "test" }, undefined, undefined, {} as never);
      (result.details as { review: { status: string } }).review.status = "mutated";

      const firstPanel = (await panels.snapshot())[0];
      if (firstPanel === undefined) throw new Error("change-verifier-panel was not registered");
      const firstLatest = (firstPanel.data as { latest: { review: { status: string } } }).latest;
      expect(firstLatest.review.status).toBe("pass");
      firstLatest.review.status = "panel-mutated";

      const secondPanel = (await panels.snapshot())[0];
      if (secondPanel === undefined) throw new Error("change-verifier-panel was not registered");
      expect((secondPanel.data as { latest: { review: { status: string } } }).latest.review.status).toBe("pass");
      await expect(verify.execute("invalid", { script: 7 }, undefined, undefined, {} as never)).rejects.toThrow(/script must be a string/iu);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "change-verifier-panel", data: { runs: 1, latest: { status: "pass" } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });
});
