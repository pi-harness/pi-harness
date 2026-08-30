import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../runtime.js";

export interface RuntimePluginConfig {
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export const Config: z<RuntimePluginConfig> = z.object({
  thinkingLevel: z.union(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("medium"),
});

export default {
  name: "pi-runtime",
  inject: ["piModels", "piResources", "piSession", "piTools"],
  Config,
  async apply(context: Context, config: RuntimePluginConfig) {
    const tools = context.piTools.snapshot();
    const { session } = await createAgentSessionFromServices({
      services: context.piResources,
      sessionManager: context.piSession.manager,
      model: context.piModels.model,
      thinkingLevel: config.thinkingLevel ?? "medium",
      tools: tools.names,
      customTools: tools.customTools,
    });
    const runtime = new PiRuntime(session);
    context.provide("piRuntime", runtime);
    context.effect(() => {
      const unsubscribe = session.subscribe((event) => {
        context.emit("pi/session-event", event);
      });
      return async () => {
        unsubscribe();
        await runtime.dispose();
      };
    });
    await session.bindExtensions({
      mode: "print",
      abortHandler: () => {
        void runtime.abort();
      },
      onError: (error) => {
        context.emit("pi/extension-error", error);
      },
    });
  },
};
