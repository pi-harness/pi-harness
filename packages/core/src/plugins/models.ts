import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

export interface ModelsPluginConfig {
  provider: string;
  model: string;
  refreshOnCreate?: boolean;
}

const maxProviderIdLength = 128;
const maxModelIdLength = 512;
const modelSelectionIdPattern = /^[^\s\p{Cc}]+$/u;
const modelRefreshTimeoutMs = 15_000;

export const Config: z<ModelsPluginConfig> = z.object({
  provider: z.string().required().min(1).max(maxProviderIdLength).pattern(modelSelectionIdPattern),
  model: z.string().required().min(1).max(maxModelIdLength).pattern(modelSelectionIdPattern),
  refreshOnCreate: z.boolean().default(false),
});

export default {
  name: "pi-models",
  inject: ["piHarnessLaunch"],
  Config,
  async apply(context: Context, config: ModelsPluginConfig) {
    assertKnownConfigKeys("pi-models", config, ["provider", "model", "refreshOnCreate"]);
    const agentDir = context.piHarnessLaunch.agentDir;
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: config.refreshOnCreate ?? false,
      allowModelNetwork: config.refreshOnCreate ?? false,
      modelRefreshTimeoutMs,
    });
    const runtimeError = runtime.getError();
    if (runtimeError !== undefined) throw new Error(runtimeError);
    context.provide("piModelRuntime", { runtime, provider: config.provider, model: config.model });
  },
};
