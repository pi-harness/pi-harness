import { Context } from "@deepseek-ai/cordis";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import modelPlugin from "../src/plugins/model.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createContext(provider = "deepseek", model = "deepseek-v4-flash"): Promise<Context> {
  const context = new Context();
  contexts.push(context);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  context.provide("piModelRuntime", { runtime, provider, model });
  context.provide("piResources", {} as never);
  return context;
}

describe("model plugin", () => {
  test("rejects a non-object configuration instead of treating it as empty", async () => {
    const context = await createContext();
    let activationError: unknown;
    try {
      await context.plugin(modelPlugin, 42 as never);
    } catch (error) {
      activationError = error;
    }

    expect(activationError).toBeInstanceOf(Error);
    expect(context.get("piModels")).toBeUndefined();
  });

  test("rejects unknown configuration without publishing a partial selection", async () => {
    const context = await createContext();

    await expect(context.plugin(modelPlugin, { fallback: true })).rejects.toThrow(/Unknown pi-model config keys: fallback/u);
    expect(context.get("piModels")).toBeUndefined();
  });

  test("publishes the exact registered model from the shared runtime", async () => {
    const context = await createContext();
    const expected = context.piModelRuntime.runtime.getModel("deepseek", "deepseek-v4-flash");
    expect(expected).toBeDefined();

    await context.plugin(modelPlugin);

    expect(context.piModels.runtime).toBe(context.piModelRuntime.runtime);
    expect(context.piModels.model).toBe(expected);
  });

  test("removes the selected model service on disposal", async () => {
    const context = await createContext();
    await context.plugin(modelPlugin);
    expect(context.get("piModels")).toBeDefined();

    await context.fiber.dispose();

    expect(context.get("piModels")).toBeUndefined();
  });
});
