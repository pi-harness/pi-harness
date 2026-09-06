import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "../config.js";

type ReloadState = {
  status: "idle" | "queued" | "running" | "reloaded" | "failed" | "cancelled";
  reason: string;
  requestedAt?: string;
  startedAt?: string;
  reloadedAt?: string;
  error?: string;
};

const maxReasonLength = 1_000;
const maxErrorLength = 2_000;
const parameterNames = new Set(["reason"]);

function reloadReason(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin Dev parameters must be an object");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Plugin Dev parameters must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !parameterNames.has(key)))
    throw new Error("Plugin Dev parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Plugin Dev parameters must use data properties");
  const reason: unknown = descriptors.reason?.value as unknown;
  if (reason === undefined) return "manual plugin reload";
  if (typeof reason !== "string") throw new Error("Plugin Dev reason must be a string");
  if (reason.length > maxReasonLength) throw new Error(`Plugin Dev reason must contain 0-${maxReasonLength} characters`);
  if (reason.includes("\0")) throw new Error("Plugin Dev reason must not contain NUL characters");
  return reason.trim() || "manual plugin reload";
}

function boundedError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxErrorLength);
  if (error !== null && typeof error === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value.slice(0, maxErrorLength);
  }
  return "Unknown plugin reload error";
}

function cancellationError(signal: AbortSignal): Error {
  return new Error("Plugin reload wait was cancelled", { cause: signal.reason });
}

function waitForReload<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellationError(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(cancellationError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error("Plugin reload failed with a non-Error reason", { cause: error }));
      },
    );
  });
}

export default {
  name: "pi-plugin-dev",
  inject: ["piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    let latest: ReloadState = { status: "idle", reason: "" };
    let queued: { reason: string; requestedAt: string } | undefined;
    let active: Promise<ReloadState> | undefined;
    const startReload = (request: { reason: string; requestedAt: string }): Promise<ReloadState> => {
      if (lifecycle.signal.aborted) {
        latest = { status: "cancelled", ...request, error: "Plugin reload was cancelled before it started" };
        return Promise.reject(cancellationError(lifecycle.signal));
      }
      const runtime = context.get("piRuntime") as { session: { reload(): Promise<void> } } | undefined;
      if (runtime === undefined) {
        const error = new Error("Pi runtime is not available; enable the runtime plugin before reloading");
        latest = { status: "failed", ...request, error: error.message };
        return Promise.reject(error);
      }
      const startedAt = new Date().toISOString();
      latest = { status: "running", ...request, startedAt };
      const operation = Promise.resolve()
        .then(() => runtime.session.reload())
        .then(
          () => {
            const result: ReloadState = { status: "reloaded", ...request, startedAt, reloadedAt: new Date().toISOString() };
            latest = { ...result };
            return result;
          },
          (error: unknown) => {
            latest = { status: "failed", ...request, startedAt, error: boundedError(error) };
            throw error;
          },
        );
      active = operation;
      void operation.then(
        () => {
          if (active === operation) active = undefined;
        },
        () => {
          if (active === operation) active = undefined;
        },
      );
      return operation;
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      if (event.type !== "agent_settled" || queued === undefined) return;
      const request = queued;
      queued = undefined;
      void startReload(request).catch(() => undefined);
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "plugin_dev_reload",
        label: "Reload Pi session resources",
        description: "Reload the current Pi session extensions, skills, prompts, themes, and context files after local development changes.",
        promptSnippet: "reload live Pi session resources after local development changes",
        parameters: Type.Object(
          { reason: Type.Optional(Type.String({ description: "Why the reload is being requested", maxLength: maxReasonLength })) },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<ReloadState>> {
          const reason = reloadReason(params);
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const requestedAt = new Date().toISOString();
          if (operationSignal.aborted) {
            latest = { status: "cancelled", reason, requestedAt, error: "Plugin reload was cancelled before it started" };
            throw cancellationError(operationSignal);
          }
          if (active !== undefined || queued !== undefined) throw new Error("A plugin reload is already in progress");
          const runtime = context.get("piRuntime") as { session: { isIdle?: boolean; reload(): Promise<void> } } | undefined;
          if (runtime === undefined) {
            const error = new Error("Pi runtime is not available; enable the runtime plugin before reloading");
            latest = { status: "failed", reason, requestedAt, error: error.message };
            throw error;
          }
          if (runtime.session.isIdle === false) {
            queued = { reason, requestedAt };
            latest = { status: "queued", ...queued };
            return {
              content: [{ type: "text", text: `Pi session resource reload queued until the current agent run settles: ${reason}` }],
              details: { ...latest },
            };
          }
          const result = await waitForReload(startReload({ reason, requestedAt }), operationSignal);
          return { content: [{ type: "text", text: `Pi session resources reloaded: ${reason}` }], details: { ...result } };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "plugin-dev-panel",
        pluginId: "@pi-harness/core/plugins/plugin-dev",
        title: "Plugin Dev",
        description: "在本地开发改动后安全重载当前 Pi session 的扩展、技能、提示词、主题和上下文文件。",
        icon: "↻",
        read: () => ({
          ...latest,
          limits: { reasonCharacters: maxReasonLength, errorCharacters: maxErrorLength },
        }),
      });
    } catch (error) {
      lifecycle.abort(new Error("Plugin Dev plugin activation failed", { cause: error }));
      unsubscribe();
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Plugin Dev plugin was disposed"));
      if (queued !== undefined) {
        latest = { status: "cancelled", ...queued, error: "Plugin reload was cancelled before it started" };
        queued = undefined;
      }
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
