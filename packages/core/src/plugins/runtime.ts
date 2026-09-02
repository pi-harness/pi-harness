import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createAgentSessionFromServices, createAgentSessionRuntime, type AgentSession, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
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
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = cwd === context.piResources.cwd ? context.piResources : await context.piResources.createForCwd(cwd);
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        model: context.piModels.model,
        thinkingLevel: config.thinkingLevel ?? "medium",
        tools: requestedTools,
        customTools: tools.customTools,
      });
      if (result.extensionsResult.errors.length > 0) {
        result.session.dispose();
        throw new Error(`Pi extensions failed to load:\n${result.extensionsResult.errors.map((failure) => `${failure.path}: ${failure.error}`).join("\n")}`);
      }
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const sessionRuntime = await createAgentSessionRuntime(createRuntime, {
      cwd: context.piResources.cwd,
      agentDir: context.piResources.agentDir,
      sessionManager: context.piSession.manager,
    });
    const runtime = new PiRuntime(sessionRuntime);
    const bindSession = async (session: AgentSession): Promise<void> => {
      await session.bindExtensions({
        mode: "print",
        abortHandler: () => {
          void runtime.abort();
        },
        onError: (error) => {
          context.emit("pi/extension-error", error);
        },
      });
      // Reconciled after binding so a tool an extension registers from session_start is visible here.
      const activeTools = new Set(session.getAllTools().map((tool) => tool.name));
      const missingTools = requestedTools.filter((name) => !activeTools.has(name));
      if (missingTools.length > 0) throw new Error(`Pi tools are not registered: ${missingTools.join(", ")}`);
    };
    let unsubscribe: (() => void) | undefined;
    const rebindSession = async (session: AgentSession): Promise<void> => {
      unsubscribe?.();
      await bindSession(session);
      unsubscribe = session.subscribe((event) => {
        // A throwing listener must not unwind back into Pi's event dispatch and kill the run.
        try {
          context.emit("pi/session-event", event);
        } catch (error) {
          context.emit("pi/extension-error", { extensionPath: "pi/session-event", event: event.type, error: error instanceof Error ? error.message : String(error) });
        }
      });
    };
    try {
      context.effect(() => {
        return async () => {
          unsubscribe?.();
          await runtime.dispose();
        };
      });
      context.provide("piRuntime", runtime);
      sessionRuntime.setRebindSession(rebindSession);
      await rebindSession(sessionRuntime.session);
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  },
};
