import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PiTelemetryEvent, PiTelemetryService } from "../services.js";

type TelemetrySnapshot = { blocked: number; names: readonly string[] };

function eventName(value: string): string {
  const name = value.trim().slice(0, 80);
  if (name.length === 0) throw new Error("Telemetry event name must not be empty");
  return name;
}

export default {
  name: "pi-telemetry-blocker",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let blocked = 0;
    const names: string[] = [];
    const record = (event: PiTelemetryEvent): { blocked: true; name: string } => {
      const name = eventName(event.name);
      blocked += 1;
      if (!names.includes(name)) names.push(name);
      return { blocked: true, name };
    };
    const service: PiTelemetryService = {
      enabled: false,
      send: record,
      snapshot: (): TelemetrySnapshot => ({ blocked, names: [...names] }),
    };
    context.provide("piTelemetry", service);
    const unsubscribe = context.on("pi/telemetry", (event) => {
      record(event);
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "telemetry_status",
        label: "Telemetry status",
        description: "Report the local telemetry policy. Pi Harness telemetry is disabled and no event properties are retained.",
        promptSnippet: "check whether telemetry is enabled",
        parameters: Type.Object({}),
        async execute(): Promise<AgentToolResult<TelemetrySnapshot>> {
          const snapshot = service.snapshot();
          return { content: [{ type: "text", text: `Telemetry disabled; blocked ${snapshot.blocked} event(s).` }], details: snapshot };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "telemetry-blocker-panel",
      pluginId: "@pi-harness/core/plugins/telemetry-blocker",
      title: "Telemetry Blocker",
      description: "默认关闭遥测，只保留事件名和计数，不保存事件属性。",
      icon: "⊘",
      read: () => ({ enabled: service.enabled, blocked, names: [...names] }),
    });
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
