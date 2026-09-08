import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile, readBoundedTextFile, type PiMcpServerSnapshot } from "@pi-harness/plugin-api";
import { validateCommand as validateServerCommand } from "@pi-harness/plugin-mcp-client";

type McpPanelServer = Omit<PiMcpServerSnapshot, "command"> & { executable: string; toolCount: number | null; statusSource: "runtime" };
type McpPanelHealth = { serverId: string; status: string; severity: "ok" | "warning"; suggestions: string[] };
const maxPatchBytes = 2 * 1024 * 1024;

export interface McpPanelPluginConfig {
  patchPath?: string;
}

export const Config: z<McpPanelPluginConfig> = z.object({ patchPath: z.string().default("") });

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
  if (command.length === 0 || command.length > 32 || command.some((part) => part.trim() === ""))
    throw new Error("MCP command must contain 1-32 non-empty arguments");
  // The loader validates the same field at activation, so a patch this panel writes must satisfy its argument and shell-wrapper rules or the next launch fails.
  validateServerCommand(command);
  return [...command];
}

function patchFragment(serverId: string, command: readonly string[], autoStart: boolean): string {
  const rowId = `mcp-${serverId}`;
  const commandRows = command.map((part) => `          - ${JSON.stringify(part)}`).join("\n");
  return [
    `- id: ${rowId}`,
    `  name: "@pi-harness/plugin-mcp-client"`,
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
    const lifecycle = new AbortController();
    const inventories = new Map<string, { startedAt: number; count: number }>();
    const snapshot = (): McpPanelServer[] => {
      return context.piMcp.snapshot().servers.map((server) => ({
        id: server.id,
        status: server.status,
        startedAt: server.startedAt,
        executable: basename(server.command[0] ?? ""),
        toolCount: server.status === "running" && inventories.get(server.id)?.startedAt === server.startedAt ? inventories.get(server.id)!.count : null,
        statusSource: "runtime",
      }));
    };
    const buildPatch = (serverId: string, command: readonly string[], autoStart: boolean): string =>
      patchFragment(validateServerId(serverId), validateCommand(command), autoStart);
    let patchWriteQueue = Promise.resolve();
    const applyPatch = async (fragment: string, serverId: string, signal: AbortSignal): Promise<string> => {
      const write = patchWriteQueue.then(async () => {
        signal.throwIfAborted();
        if (patchTarget === undefined) throw new Error("MCP profile writes are disabled; configure patchPath first");
        await mkdir(dirname(patchTarget), { recursive: true });
        const metadata = await lstat(patchTarget).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (metadata?.isSymbolicLink() || (metadata !== undefined && !metadata.isFile()))
          throw new Error("MCP profile patch target must be a regular file and cannot be a symbolic link");
        let existing = "";
        if (metadata !== undefined) {
          existing = await readBoundedTextFile(patchTarget, maxPatchBytes, "MCP profile patch");
        }
        const rowPattern = new RegExp(`^- id: mcp-${serverId}\\s*$`, "mu");
        if (rowPattern.test(existing)) throw new Error(`MCP server patch already exists: ${serverId}`);
        const next = `${existing.trimEnd()}${existing.trimEnd() === "" ? "" : "\n"}${fragment}`;
        if (Buffer.byteLength(next, "utf8") > maxPatchBytes) throw new Error("MCP profile patch exceeds the 2 MiB output limit");
        const backup = `${patchTarget}.bak`;
        signal.throwIfAborted();
        await atomicWriteFile(backup, existing, { encoding: "utf8", mode: 0o600, signal });
        await atomicWriteFile(patchTarget, next, { encoding: "utf8", mode: 0o600, signal });
        return patchTarget;
      });
      patchWriteQueue = write.then(
        () => undefined,
        () => undefined,
      );
      return write;
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "mcp_panel",
        label: "MCP panel",
        description: "Inspect MCP status and tools, derive health suggestions, and preview or explicitly apply a backed-up profile patch.",
        promptSnippet: "inspect MCP status or preview a server profile patch",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("status"), Type.Literal("tools"), Type.Literal("health"), Type.Literal("preview"), Type.Literal("apply")]),
            serverId: Type.Optional(Type.String({ description: "Configured or running MCP server id" })),
            command: Type.Optional(Type.Array(Type.String(), { description: "MCP server executable and arguments" })),
            autoStart: Type.Optional(Type.Boolean({ description: "Start the configured server with the runtime" })),
            confirm: Type.Optional(Type.Boolean({ description: "Must be true before applying a patch" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(toolCallId, params, signal, onUpdate, toolContext): Promise<AgentToolResult<unknown>> {
          await Promise.resolve();
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          operationSignal.throwIfAborted();
          const servers = snapshot();
          if (params.action === "status") {
            return {
              content: [
                {
                  type: "text",
                  text:
                    servers
                      .map((server) => `${server.id}: ${server.status} · ${server.toolCount === null ? "tools not queried" : `${server.toolCount} tools`}`)
                      .join("\n") || "No MCP servers configured.",
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
            const path = await applyPatch(fragment, serverId, operationSignal);
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
          const listTool = context.piTools.snapshot().customTools.find((tool) => tool.name === "mcp_list_tools");
          if (listTool === undefined) throw new Error("MCP tool discovery is unavailable; enable the MCP client first");
          const result = await listTool.execute(toolCallId, { serverId: server.id }, operationSignal, onUpdate, toolContext);
          operationSignal.throwIfAborted();
          const tools = structuredClone((result.details as { tools: Array<{ name: string; description?: string }> }).tools);
          const current = context.piMcp.snapshot().servers.find((item) => item.id === server.id);
          if (current?.status === "running" && current.startedAt === server.startedAt)
            inventories.set(server.id, { startedAt: server.startedAt, count: tools.length });
          return {
            content: [{ type: "text", text: tools.map((tool) => `${tool.name}: ${tool.description ?? ""}`).join("\n") || "No MCP tools." }],
            details: { action: "tools", serverId: server.id, tools },
          };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "mcp-panel",
        pluginId: "@pi-harness/plugin-mcp-panel",
        title: "MCP Console",
        description: "查看 MCP 服务器状态、工具和健康建议。",
        icon: "⌘",
        read: () => ({ servers: snapshot(), statusSource: "runtime", writesEnabled: patchTarget !== undefined, patchPath: patchTarget ?? null }),
      });
    } catch (error) {
      unregister();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("MCP panel plugin is disposed"));
      inventories.clear();
      unregister();
      disposePanel();
    });
  },
};
