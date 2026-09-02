import type { Context } from "@deepseek-ai/cordis";

type Failure = { time: string; source: string; message: string };

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "error" in error) {
    const { error: message, extensionPath } = error as { error: unknown; extensionPath?: unknown };
    const text = typeof message === "string" ? message : String(message);
    return typeof extensionPath === "string" ? `${extensionPath}: ${text}` : text;
  }
  return typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
}

export default {
  name: "pi-fail-logger",
  inject: ["piPluginUi"],
  apply(context: Context) {
    const failures: Failure[] = [];
    let previous: string | undefined;
    const record = (source: string, error: unknown): void => {
      const message = messageOf(error);
      const fingerprint = `${source}:${message}`;
      if (fingerprint === previous) return;
      previous = fingerprint;
      failures.push({ time: new Date().toISOString(), source, message });
      if (failures.length > 50) failures.shift();
    };
    const unsubscribeExtension = context.on("pi/extension-error", (error) => record("extension", error));
    const unsubscribeSession = context.on("pi/session-event", (event) => {
      const last = event.type === "agent_end" ? event.messages.at(-1) : undefined;
      if (last?.role === "assistant" && last.stopReason === "error") {
        record("agent", last.errorMessage ?? "Agent turn failed");
      }
      if (event.type === "compaction_end" && event.errorMessage) record("compaction", event.errorMessage);
    });
    const disposePanel = context.piPluginUi.register({
      id: "fail-logger-panel",
      pluginId: "@pi-harness/core/plugins/fail-logger",
      title: "Failure Logger",
      description: "集中记录扩展、Agent 和上下文压缩错误，并去重重复故障。",
      icon: "!",
      read: () => ({ total: failures.length, failures: [...failures].reverse() }),
    });
    context.effect(() => () => {
      unsubscribeExtension();
      unsubscribeSession();
      disposePanel();
    });
  },
};
