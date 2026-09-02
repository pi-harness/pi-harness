import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiMcpServerSnapshot } from "../services.js";

type McpPanelServer = PiMcpServerSnapshot & { toolCount: number; statusSource: "runtime" };
type McpPanelHealth = { serverId: string; status: string; severity: "ok" | "warning"; suggestions: string[] };

function mcpToolPrefix(serverId: string): string {
  return `mcp__${serverId}__`;
}

function serverTools(serverId: string, tools: readonly ToolDefinition[]): ToolDefinition[] {
  const prefix = mcpToolPrefix(serverId);
  return tools.filter((tool) => tool.name.startsWith(prefix));
}

function healthFor(server: McpPanelServer | undefined): McpPanelHealth {
  if (server === undefined) throw new Error("MCP server was not found");
  if (server.status === "running") return { serverId: server.id, status: server.status, severity: "ok", suggestions: [] };
  return { serverId: server.id, status: server.status, severity: "warning", suggestions: ["使用 mcp_server_start 启动该服务器，再重新检查健康状态。"] };
}

export default {
  name: "pi-mcp-panel",
  inject: ["piMcp", "piPluginUi", "piTools"],
  apply(context: Context) {
    const snapshot = (): McpPanelServer[] => {
      const customTools = context.piTools.snapshot().customTools;
      return context.piMcp.snapshot().servers.map((server) => ({
        ...server,
        command: [...server.command],
        toolCount: serverTools(server.id, customTools).length,
        statusSource: "runtime",
      }));
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "mcp_panel",
        label: "MCP panel",
        description: "Inspect MCP server status, bridged tools, and derived health suggestions without changing server configuration.",
        promptSnippet: "inspect MCP server status and available bridged tools",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("status"), Type.Literal("tools"), Type.Literal("health")]),
          serverId: Type.Optional(Type.String({ description: "Configured or running MCP server id" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
          await Promise.resolve();
          const servers = snapshot();
          if (params.action === "status") {
            return {
              content: [
                {
                  type: "text",
                  text: servers.map((server) => `${server.id}: ${server.status} · ${server.toolCount} tools`).join("\n") || "No MCP servers configured.",
                },
              ],
              details: { action: "status", servers },
            };
          }
          if (params.serverId === undefined || params.serverId.trim() === "") throw new Error(`action ${params.action} requires serverId`);
          const server = servers.find((item) => item.id === params.serverId);
          if (params.action === "health") {
            const health = healthFor(server);
            return { content: [{ type: "text", text: `${health.serverId}: ${health.status} (${health.severity})` }], details: { action: "health", ...health } };
          }
          if (server === undefined) throw new Error(`MCP server was not found: ${params.serverId}`);
          const tools = serverTools(server.id, context.piTools.snapshot().customTools).map((tool) => ({ name: tool.name, description: tool.description }));
          return {
            content: [{ type: "text", text: tools.map((tool) => `${tool.name}: ${tool.description ?? ""}`).join("\n") || "No bridged tools." }],
            details: { action: "tools", serverId: server.id, tools },
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "mcp-panel",
      pluginId: "@pi-harness/core/plugins/mcp-panel",
      title: "MCP Console",
      description: "查看 MCP 服务器状态、桥接工具和健康建议。",
      icon: "⌘",
      read: () => ({ servers: snapshot(), statusSource: "runtime" }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
