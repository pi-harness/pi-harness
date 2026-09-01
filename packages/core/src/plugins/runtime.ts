import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../runtime.js";
import { assertKnownConfigKeys } from "../config.js";

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
    assertKnownConfigKeys("pi-runtime", config, ["thinkingLevel"]);
    const tools = context.piTools.acquire();
    context.effect(() => () => tools.release());
    const requestedTools = [...tools.names, ...tools.customTools.map((tool) => tool.name)];
    const { session } = await createAgentSessionFromServices({
      services: context.piResources,
      sessionManager: context.piSession.manager,
      model: context.piModels.model,
      thinkingLevel: config.thinkingLevel ?? "medium",
      tools: requestedTools,
      customTools: tools.customTools,
    });
    const activeTools = new Set(session.getAllTools().map((tool) => tool.name));
    const missingTools = requestedTools.filter((name) => !activeTools.has(name));
    if (missingTools.length > 0) {
      session.dispose();
      throw new Error(`Pi tools are not registered: ${missingTools.join(", ")}`);
    }
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
