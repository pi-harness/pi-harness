import { join } from "node:path";
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
  inject: ["piHarnessLaunch"],
  Config,
  async apply(context: Context, config: ModelsPluginConfig) {
    const agentDir = context.piHarnessLaunch.agentDir;
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: config.refreshOnCreate ?? false,
    });
    context.provide("piModelRuntime", { runtime, provider: config.provider, model: config.model });
  },
};
