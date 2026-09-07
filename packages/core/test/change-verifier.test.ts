import { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import changeVerifierPlugin from "../src/plugins/change-verifier.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

async function createVerifier(options?: { reviewStatus?: unknown; testDurationMs?: unknown; testExitCode?: unknown }): Promise<{
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
        return Promise.resolve({
          content: [{ type: "text" as const, text: "reviewed" }],
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
        return Promise.resolve({
          content: [{ type: "text" as const, text: "tested" }],
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
