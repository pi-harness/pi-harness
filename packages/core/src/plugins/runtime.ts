import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../runtime.js";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

export interface RuntimePluginConfig {
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export const Config: z<RuntimePluginConfig> = z.object({
  thinkingLevel: z.union(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("medium"),
});

// Cordis disposes the outgoing fiber and applies the replacement concurrently, so an HMR reload
// would otherwise build a second AgentSession over the same SessionManager while the first is still
// streaming, interleaving both runs into one JSONL transcript. Each manager therefore has at most
// one runtime under construction or teardown at a time.
const sessionManagerGate = new WeakMap<SessionManager, Promise<void>>();
const maxForwardedErrorLength = 2_000;

function boundedListenerError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxForwardedErrorLength);
  if (error !== null && typeof error === "object") {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value.slice(0, maxForwardedErrorLength);
    } catch {
      // Proxy descriptor traps are untrusted too.
    }
  }
  return "Unknown pi/session-event listener error";
}

function enterSessionManagerGate(manager: SessionManager): { ready: Promise<void>; release: () => void } {
  const ready = sessionManagerGate.get(manager) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionManagerGate.set(
    manager,
    ready.then(
      () => held,
      () => held,
    ),
  );
  return { ready, release };
}

export default {
  name: "pi-runtime",
  inject: ["piModels", "piResources", "piSession", "piTools"],
  Config,
  async apply(context: Context, config: RuntimePluginConfig) {
    assertKnownConfigKeys("pi-runtime", config, ["thinkingLevel"]);
    const gate = enterSessionManagerGate(context.piSession.manager);
    await gate.ready;
    const emitExtensionError = (error: ExtensionError): void => {
      try {
        context.emit("pi/extension-error", error);
      } catch {
        // Error observers are diagnostic only and must never interrupt runtime lifecycle work.
      }
    };
    let runtime: PiRuntime | undefined;
    let releaseTools: (() => void) | undefined;
    try {
      const tools = context.piTools.acquire();
      releaseTools = () => tools.release();
      context.effect(() => () => tools.release());
      const requestedTools = [...tools.names, ...tools.customTools.map((tool) => tool.name)];
      const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
        // A ResourceLoader owns instantiated extensions and their ExtensionAPI runtime. Once a
        // session is disposed Pi invalidates that runtime, so reusing same-cwd services would run
        // the replacement session_start handlers with stale load-time `pi` objects. The initial
        // session can use the services prepared by pi-resources; every replacement needs a fresh
        // extension set, even when its cwd is unchanged.
        const services = runtime === undefined && cwd === context.piResources.cwd ? context.piResources : await context.piResources.createForCwd(cwd);
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
        // An abort from a completed message/tool must settle before next-turn preparation.
        // Otherwise the SDK's lazy provider setup can classify the already-aborted
        // request as an ordinary error, producing a spurious HTTP 502 and failure log.
        const shouldStopAfterTurn = result.session.agent.shouldStopAfterTurn;
        result.session.agent.shouldStopAfterTurn = async (turn, signal) => {
          signal?.throwIfAborted();
          const stopped = await shouldStopAfterTurn?.(turn, signal);
          signal?.throwIfAborted();
          return stopped ?? false;
        };
        return { ...result, services, diagnostics: services.diagnostics };
      };
      const sessionRuntime = await createAgentSessionRuntime(createRuntime, {
        cwd: context.piResources.cwd,
        agentDir: context.piResources.agentDir,
        sessionManager: context.piSession.manager,
      });
      const createdRuntime = new PiRuntime(sessionRuntime);
      runtime = createdRuntime;
      const bindSession = async (session: AgentSession): Promise<void> => {
        await session.bindExtensions({
          mode: "print",
          abortHandler: () => {
            void createdRuntime.abort();
          },
          onError: (error) => {
            emitExtensionError(error);
          },
        });
        // Reconciled after binding so a tool an extension registers from session_start is visible here.
        const registeredTools = session.getAllTools().map((tool) => tool.name);
        const missingTools = requestedTools.filter((name) => !registeredTools.includes(name));
        if (missingTools.length > 0) throw new Error(`Pi tools are not registered: ${missingTools.join(", ")}`);
        // Pi treats the tool list as an allowlist, so anything an extension contributed but the
        // profile did not name is dropped. Report it rather than letting the tool vanish silently.
        const activeTools = new Set(session.getActiveToolNames());
        const droppedTools = registeredTools.filter((name) => !activeTools.has(name));
        if (droppedTools.length > 0)
          emitExtensionError({
            extensionPath: "pi-tools",
            event: "session_start",
            error: `Pi tools registered by extensions are not enabled because the profile does not list them: ${droppedTools.join(", ")}; add them to the pi-tools names option to enable them`,
          });
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
            emitExtensionError({
              extensionPath: "pi/session-event",
              event: event.type,
              error: boundedListenerError(error),
            });
          }
        });
      };
      context.effect(() => {
        return async () => {
          unsubscribe?.();
          try {
            await createdRuntime.dispose();
          } finally {
            // Released only once teardown has finished, so a replacement fiber cannot build a
            // second session over this SessionManager while this one is still writing to it.
            gate.release();
          }
        };
      });
      context.provide("piRuntime", createdRuntime);
      sessionRuntime.setRebindSession(rebindSession);
      await rebindSession(sessionRuntime.session);
    } catch (error) {
      try {
        if (runtime !== undefined) await runtime.dispose();
      } finally {
        releaseTools?.();
        gate.release();
      }
      throw error;
    }
  },
};
