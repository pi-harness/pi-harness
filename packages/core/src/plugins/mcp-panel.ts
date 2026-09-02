import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiMcpServerSnapshot } from "../services.js";

type McpPanelServer = PiMcpServerSnapshot & { toolCount: number; statusSource: "runtime" };
type McpPanelHealth = { serverId: string; status: string; severity: "ok" | "warning"; suggestions: string[] };

export interface McpPanelPluginConfig {
  patchPath?: string;
}

export const Config: z<McpPanelPluginConfig> = z.object({ patchPath: z.string().default("") });

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

function validateServerId(serverId: string): string {
  const normalized = serverId.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(normalized)) throw new Error("MCP server id must use letters, numbers, _ or -");
  return normalized;
}

function validateCommand(command: readonly string[]): string[] {
  if (command.length === 0 || command.length > 32 || command.some((part) => part.trim() === "" || part.length > 4096))
    throw new Error("MCP command must contain 1-32 non-empty arguments");
  return [...command];
}

function patchFragment(serverId: string, command: readonly string[], autoStart: boolean): string {
  const rowId = `mcp-${serverId}`;
  const commandRows = command.map((part) => `          - ${JSON.stringify(part)}`).join("\n");
  return [
    `- id: ${rowId}`,
    `  name: "@pi-harness/core/plugins/mcp-client"`,
    "  config:",
    "    servers:",
    `      - id: ${JSON.stringify(serverId)}`,
    "        command:",
    commandRows,
    `        autoStart: ${autoStart ? "true" : "false"}`,
    "",
  ].join("\n");
}

export default {
  name: "pi-mcp-panel",
  inject: ["piHarnessLaunch", "piMcp", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: McpPanelPluginConfig) {
    const configuredPatchPath = config.patchPath?.trim() ?? "";
    const patchTarget =
      configuredPatchPath === ""
        ? undefined
        : isAbsolute(configuredPatchPath)
          ? resolve(configuredPatchPath)
          : resolve(context.piHarnessLaunch.agentDir, configuredPatchPath);
    const snapshot = (): McpPanelServer[] => {
      const customTools = context.piTools.snapshot().customTools;
      return context.piMcp.snapshot().servers.map((server) => ({
        ...server,
        command: [...server.command],
        toolCount: serverTools(server.id, customTools).length,
        statusSource: "runtime",
      }));
    };
    const buildPatch = (serverId: string, command: readonly string[], autoStart: boolean): string =>
      patchFragment(validateServerId(serverId), validateCommand(command), autoStart);
    const applyPatch = async (fragment: string, serverId: string): Promise<string> => {
      if (patchTarget === undefined) throw new Error("MCP profile writes are disabled; configure patchPath first");
      const existing = await readFile(patchTarget, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      const rowPattern = new RegExp(`^- id: mcp-${serverId}\\s*$`, "mu");
      if (rowPattern.test(existing)) throw new Error(`MCP server patch already exists: ${serverId}`);
      await mkdir(dirname(patchTarget), { recursive: true });
      await writeFile(`${patchTarget}.bak`, existing, { encoding: "utf8", mode: 0o600 });
      await writeFile(patchTarget, `${existing.trimEnd()}${existing.trimEnd() === "" ? "" : "\n"}${fragment}`, { encoding: "utf8", mode: 0o600 });
      return patchTarget;
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "mcp_panel",
        label: "MCP panel",
        description: "Inspect MCP status and tools, derive health suggestions, and preview or explicitly apply a backed-up profile patch.",
        promptSnippet: "inspect MCP status or preview a server profile patch",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("status"), Type.Literal("tools"), Type.Literal("health"), Type.Literal("preview"), Type.Literal("apply")]),
          serverId: Type.Optional(Type.String({ description: "Configured or running MCP server id" })),
          command: Type.Optional(Type.Array(Type.String(), { description: "MCP server executable and arguments" })),
          autoStart: Type.Optional(Type.Boolean({ description: "Start the configured server with the runtime" })),
          confirm: Type.Optional(Type.Boolean({ description: "Must be true before applying a patch" })),
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
          if (params.action === "preview" || params.action === "apply") {
            if (params.command === undefined) throw new Error(`action ${params.action} requires command`);
            const serverId = validateServerId(params.serverId);
            const fragment = buildPatch(serverId, params.command, params.autoStart === true);
            if (params.action === "preview")
              return { content: [{ type: "text", text: fragment }], details: { action: "preview", serverId, path: patchTarget ?? null, fragment } };
            if (params.confirm !== true) throw new Error("Applying an MCP profile patch requires confirm=true");
            const path = await applyPatch(fragment, serverId);
            return {
              content: [{ type: "text", text: `MCP server patch appended to ${path}.` }],
              details: { action: "apply", serverId, path, backup: `${path}.bak` },
            };
          }
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
      read: () => ({ servers: snapshot(), statusSource: "runtime", writesEnabled: patchTarget !== undefined, patchPath: patchTarget ?? null }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
