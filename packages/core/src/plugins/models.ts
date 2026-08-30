import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelsPluginConfig {
  provider: string;
  model: string;
  refreshOnCreate?: boolean;
}

export const Config: z<ModelsPluginConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  refreshOnCreate: z.boolean().default(false),
});

export default {
  name: "pi-models",
  Config,
  async apply(context: Context, config: ModelsPluginConfig) {
    const runtime = await ModelRuntime.create({ refreshOnCreate: config.refreshOnCreate ?? false });
    const model = runtime.getModel(config.provider, config.model);
    if (model === undefined) throw new Error(`Pi model is not registered: ${config.provider}/${config.model}`);
    context.provide("piModels", { runtime, model });
  },
};
