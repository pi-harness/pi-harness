import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type ReloadState = { status: "idle" | "reloaded" | "failed"; reason: string; reloadedAt?: string; error?: string };

export default {
  name: "pi-plugin-dev",
  inject: ["piRuntime", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: ReloadState = { status: "idle", reason: "" };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "plugin_dev_reload",
        label: "Reload Pi plugins",
        description: "Reload the current Pi session so local extension and plugin changes take effect.",
        promptSnippet: "reload the live Pi session after changing a local plugin",
        parameters: Type.Object({ reason: Type.Optional(Type.String({ description: "Why the reload is being requested" })) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<ReloadState>> {
          const reason = params.reason?.trim() || "manual plugin reload";
          try {
            await context.piRuntime.session.reload();
            latest = { status: "reloaded", reason, reloadedAt: new Date().toISOString() };
            return { content: [{ type: "text", text: `Pi plugins reloaded: ${reason}` }], details: latest };
          } catch (error) {
            latest = { status: "failed", reason, error: error instanceof Error ? error.message : String(error) };
            throw error;
          }
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "plugin-dev-panel",
      pluginId: "@pi-harness/core/plugins/plugin-dev",
      title: "Plugin Dev",
      description: "在本地插件改动后重载当前 Pi session。",
      icon: "↻",
      read: () => latest,
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
