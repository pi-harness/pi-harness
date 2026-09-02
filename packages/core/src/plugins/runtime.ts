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
    const { session, extensionsResult } = await createAgentSessionFromServices({
      services: context.piResources,
      sessionManager: context.piSession.manager,
      model: context.piModels.model,
      thinkingLevel: config.thinkingLevel ?? "medium",
      tools: requestedTools,
      customTools: tools.customTools,
    });
    if (extensionsResult.errors.length > 0) {
      session.dispose();
      throw new Error(`Pi extensions failed to load:\n${extensionsResult.errors.map((failure) => `${failure.path}: ${failure.error}`).join("\n")}`);
    }
    const runtime = new PiRuntime(session);
    try {
      context.effect(() => {
        const unsubscribe = session.subscribe((event) => {
          try {
            context.emit("pi/session-event", event);
          } catch (error) {
            context.emit("pi/extension-error", { extensionPath: "pi/session-event", event: event.type, error: error instanceof Error ? error.message : String(error) });
          }
        });
        return async () => {
          unsubscribe();
          await runtime.dispose();
        };
      });
      context.provide("piRuntime", runtime);
      await session.bindExtensions({
        mode: "print",
        abortHandler: () => {
          void runtime.abort();
        },
        onError: (error) => {
          context.emit("pi/extension-error", error);
        },
      });
      const activeTools = new Set(session.getAllTools().map((tool) => tool.name));
      const missingTools = requestedTools.filter((name) => !activeTools.has(name));
      if (missingTools.length > 0) throw new Error(`Pi tools are not registered: ${missingTools.join(", ")}`);
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  },
};
