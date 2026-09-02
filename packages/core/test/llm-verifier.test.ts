import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";
import { parseVerifierResponse } from "../src/plugins/llm-verifier.js";
import llmVerifierPlugin from "../src/plugins/llm-verifier.js";

describe("llm verifier", () => {
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
      await expect(
        tool!.execute("call-1", { claim: "The change is covered", evidence: "npx vitest run: 3 passed" }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { verdict: "pass", model: { provider: "everyapi", id: "verifier-model" } } });
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "llm-verifier-panel", data: { latest: { verdict: "pass" } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });
});
