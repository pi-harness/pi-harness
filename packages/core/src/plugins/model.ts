import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { assertKnownConfigKeys } from "../config.js";

export const Config = z.object({});

export default {
  name: "pi-model",
  inject: ["piModelRuntime", "piResources"],
  Config,
  apply(context: Context, config: unknown) {
    assertKnownConfigKeys("pi-model", config, []);
    const { runtime, provider, model: modelId } = context.piModelRuntime;
    const model = runtime.getModel(provider, modelId);
    if (model === undefined) throw new Error(`Pi model is not registered: ${provider}/${modelId}`);
    context.provide("piModels", { runtime, model });
  },
};
