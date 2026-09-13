import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys, type PiTelemetryEvent, type PiTelemetryService } from "@pi-harness/plugin-api";
import z from "@deepseek-ai/schemastery";

type TelemetrySnapshot = ReturnType<PiTelemetryService["snapshot"]>;
export const Config = z.object({});

function eventName(event: unknown): string | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    if (event === null || typeof event !== "object" || Array.isArray(event)) return undefined;
    descriptor = Object.getOwnPropertyDescriptor(event, "name");
  } catch {
    return undefined;
  }
  const value: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  if (typeof value !== "string" || value.length > 4096 || /\p{Cc}/u.test(value)) return undefined;
  let name = value.trim().slice(0, 80);
  if (/[\uD800-\uDBFF]$/u.test(name)) name = name.slice(0, -1);
  return name.length === 0 ? undefined : name;
}

export default {
  name: "pi-telemetry-blocker",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: unknown) {
    assertKnownConfigKeys("telemetry-blocker", config, []);
    let discarded = 0;
    let observed = 0;
    let disposed = false;
    let namesTruncated = false;
    const names: string[] = [];
    const check = () => {
      if (disposed) throw new Error("Telemetry service is disposed");
    };
    context.effect(() => () => {
      disposed = true;
    });
    const remember = (name: string) => {
      if (names.includes(name)) return;
      if (names.length < 100) names.push(name);
      else namesTruncated = true;
    };
    const record = (event: PiTelemetryEvent): { discarded: true; name: string } => {
      check();
      const name = eventName(event);
      if (name === undefined) throw new Error("Telemetry event name must contain valid nonempty text");
      discarded = Math.min(Number.MAX_SAFE_INTEGER, discarded + 1);
      remember(name);
      return { discarded: true, name };
    };
    const service: PiTelemetryService = {
      enabled: false,
      send: record,
      snapshot: (): TelemetrySnapshot => {
        check();
        return { enabled: false, discarded, observed, names: [...names], namesTruncated, scope: "piTelemetry-service-and-event-observation" };
      },
    };
    context.provide("piTelemetry", service);
    const unsubscribe = context.on("pi/telemetry", (event) => {
      if (disposed) return;
      const name = eventName(event);
      if (name === undefined) return;
      observed = Math.min(Number.MAX_SAFE_INTEGER, observed + 1);
      remember(name);
    });
    context.effect(() => unsubscribe);
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "telemetry_status",
        label: "Telemetry status",
        description:
          "Report discarded piTelemetry service calls and observed bus events. This service does not intercept network traffic or other listeners; event properties are not retained.",
        promptSnippet: "check whether telemetry is enabled",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute(_toolCallId, params, signal): Promise<AgentToolResult<TelemetrySnapshot>> {
          return Promise.resolve().then(() => {
            check();
            if (signal?.aborted) throw new Error("Telemetry status was cancelled");
            if (params === null || typeof params !== "object" || Array.isArray(params) || Reflect.ownKeys(params).length !== 0)
              throw new Error("Telemetry status parameters must be an empty object");
            const snapshot = service.snapshot();
            return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
          });
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "telemetry-blocker-panel",
        pluginId: "@pi-harness/plugin-telemetry-blocker",
        title: "Telemetry Blocker",
        description: "丢弃本地遥测服务事件，区分事件总线观察；不保存属性。",
        icon: "⊘",
        read: () => service.snapshot(),
      });
    } catch (error) {
      unregisterTool();
      unsubscribe();
      throw error;
    }
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
