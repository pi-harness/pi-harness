import type { Context } from "@deepseek-ai/cordis";
import { assertKnownConfigKeys } from "../config.js";

export default {
  name: "pi-model",
  inject: ["piModelRuntime", "piResources"],
  apply(context: Context, config: unknown) {
    assertKnownConfigKeys("pi-model", config, []);
    const { runtime, provider, model: modelId } = context.piModelRuntime;
    const model = runtime.getModel(provider, modelId);
    if (model === undefined) throw new Error(`Pi model is not registered: ${provider}/${modelId}`);
    context.provide("piModels", { runtime, model });
  },
};
