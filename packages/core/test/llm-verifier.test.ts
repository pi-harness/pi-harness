import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";
import { parseVerifierResponse, summarizeVerifierHistory } from "../src/plugins/llm-verifier.js";
import llmVerifierPlugin from "../src/plugins/llm-verifier.js";

describe("llm verifier", () => {
  test("summarizes verdict history for audit panels", () => {
    expect(summarizeVerifierHistory([{ verdict: "pass" }, { verdict: "fail" }, { verdict: "unknown" }, { verdict: "pass" }] as never)).toEqual({
      total: 4,
      counts: { pass: 2, fail: 1, unknown: 1 },
      recent: [{ verdict: "pass" }, { verdict: "fail" }, { verdict: "unknown" }, { verdict: "pass" }],
    });
  });

  test("parses a bounded verdict and rationale from model output", () => {
    expect(parseVerifierResponse("VERDICT: pass\nRATIONALE: The test output covers the claimed behavior.")).toEqual({
      verdict: "pass",
      rationale: "The test output covers the claimed behavior.",
    });
    expect(parseVerifierResponse("not a structured answer")).toEqual({
      verdict: "unknown",
      rationale: "Model did not return a structured verification verdict.",
    });
  });

  test("verifies evidence through the configured model runtime", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const model = { provider: "everyapi", id: "verifier-model" };
    context.provide("piModelRuntime", {
      provider: "everyapi",
      model: "verifier-model",
      runtime: {
        getModel: () => model,
        complete: () => Promise.resolve({ content: [{ type: "text", text: "VERDICT: pass\nRATIONALE: Evidence matches the claim." }] }),
      },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(llmVerifierPlugin, {});
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "llm_verify");
      expect(tool).toBeDefined();
      expect(tool!.executionMode).toBe("sequential");
      expect(tool!.parameters).toMatchObject({ additionalProperties: false });
      await expect(
        tool!.execute("call-1", { claim: "The change is covered", evidence: "npx vitest run: 3 passed" }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { verdict: "pass", model: { provider: "everyapi", id: "verifier-model" } } });
      const batchTool = tools.snapshot().customTools.find((candidate) => candidate.name === "llm_verify_batch");
      expect(batchTool).toBeDefined();
      expect(batchTool!.executionMode).toBe("sequential");
      expect(batchTool!.parameters).toMatchObject({ additionalProperties: false });
      await expect(
        batchTool!.execute(
          "call-2",
          {
            items: [
              { claim: "The unit suite passes", evidence: "75 tests passed" },
              { claim: "The build passes", evidence: "tsc exited 0" },
            ],
          },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({ details: { results: [{ verdict: "pass" }, { verdict: "pass" }], summary: { total: 3, counts: { pass: 3 } } } });
      await expect(panels.snapshot()).resolves.toMatchObject([
        { id: "llm-verifier-panel", data: { latest: { verdict: "pass" }, history: { total: 3, counts: { pass: 3 } } } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("forwards cancellation to the model and stops the batch after an aborted turn", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const model = { provider: "everyapi", id: "verifier-model" };
    const turn = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    context.provide("piModelRuntime", {
      provider: "everyapi",
      model: "verifier-model",
      runtime: {
        getModel: () => model,
        complete: (_model: unknown, _request: unknown, options?: { signal?: AbortSignal }) => {
          signals.push(options?.signal);
          turn.abort(new Error("Turn was cancelled"));
          return Promise.resolve({ content: [{ type: "text", text: "VERDICT: pass\nRATIONALE: Evidence matches the claim." }] });
        },
      },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(llmVerifierPlugin, {});
      const batchTool = tools.snapshot().customTools.find((candidate) => candidate.name === "llm_verify_batch");
      await expect(
        batchTool!.execute(
          "call-1",
          {
            items: [
              { claim: "The first claim", evidence: "first evidence" },
              { claim: "The second claim", evidence: "second evidence" },
              { claim: "The third claim", evidence: "third evidence" },
            ],
          },
          turn.signal,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/Turn was cancelled/u);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "llm-verifier-panel", data: { latest: null, history: { total: 0 } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });
});
