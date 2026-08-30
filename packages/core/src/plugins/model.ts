import type { Context } from "@deepseek-ai/cordis";

export default {
  name: "pi-model",
  inject: ["piModelRuntime", "piResources"],
  apply(context: Context) {
    const { runtime, provider, model: modelId } = context.piModelRuntime;
    const model = runtime.getModel(provider, modelId);
    if (model === undefined) throw new Error(`Pi model is not registered: ${provider}/${modelId}`);
    context.provide("piModels", { runtime, model });
  },
};
