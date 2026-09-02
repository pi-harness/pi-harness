import { readFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PiMcpServerSnapshot } from "../services.js";

const maxQueryLength = 120;
const maxSkillBytes = 128 * 1024;

export interface SkillCatalogItem {
  name: string;
  description: string;
  filePath: string;
  source: string;
  scope: string;
  disabled: boolean;
}

export interface SkillCatalogReport {
  total: number;
  skills: SkillCatalogItem[];
  diagnostics: Array<{ type: string; message: string }>;
}

function queryText(value: string | undefined): string {
  const query = (value ?? "").trim();
  if (query.length > maxQueryLength) throw new Error(`Skill catalog query must contain 0-${maxQueryLength} characters`);
  return query.toLocaleLowerCase();
}

function readCatalog(context: Context, query?: string): SkillCatalogReport {
  const loaded = context.piResources.resourceLoader.getSkills();
  const normalized = queryText(query);
  const skills = loaded.skills
    .map((skill): SkillCatalogItem => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      source: skill.sourceInfo.source,
      scope: skill.sourceInfo.scope,
      disabled: skill.disableModelInvocation,
    }))
    .filter((skill) => normalized === "" || `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(normalized));
  return {
    total: skills.length,
    skills,
    diagnostics: loaded.diagnostics.map((diagnostic) => ({ type: diagnostic.type, message: diagnostic.message })),
  };
}

export default {
  name: "pi-skill-catalog",
  inject: ["piResources", "piMcp", "piPluginUi", "piTools"],
  apply(context: Context) {
    const readMcp = (): { servers: readonly PiMcpServerSnapshot[] } => context.piMcp.snapshot();
    const unregister = context.piTools.register(
      defineTool({
        name: "skill_catalog",
        label: "Skill catalog",
        description: "Inspect loaded Agent Skills, read one skill file, and inspect managed MCP server status without changing configuration.",
        promptSnippet: "inspect loaded skills or managed MCP server status",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("mcp")]),
          query: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
        }),
        async execute(
          _toolCallId,
          params,
        ): Promise<AgentToolResult<SkillCatalogReport | { name: string; content: string } | { servers: readonly PiMcpServerSnapshot[] }>> {
          if (params.action === "mcp") {
            const result = readMcp();
            return {
              content: [{ type: "text", text: result.servers.map((server) => `${server.id}: ${server.status}`).join("\n") || "No MCP servers configured." }],
              details: result,
            };
          }
          const report = readCatalog(context, params.query);
          if (params.action === "list") {
            return {
              content: [{ type: "text", text: report.skills.map((skill) => `${skill.name}: ${skill.description}`).join("\n") || "No matching skills loaded." }],
              details: report,
            };
          }
          const name = (params.name ?? "").trim();
          if (name === "") throw new Error("Skill name is required");
          const skill = report.skills.find((candidate) => candidate.name === name);
          if (skill === undefined) throw new Error(`Skill was not found: ${name}`);
          const content = await readFile(skill.filePath, "utf8");
          if (Buffer.byteLength(content, "utf8") > maxSkillBytes) throw new Error(`Skill file exceeds ${maxSkillBytes} bytes`);
          return { content: [{ type: "text", text: content }], details: { name, content } };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "skill-catalog-panel",
      pluginId: "@pi-harness/core/plugins/skill-catalog",
      title: "Skills Catalog",
      description: "查看当前运行时加载的 Skills 与 MCP 服务器状态。",
      icon: "✦",
      read: () => {
        const report = readCatalog(context);
        const mcp = readMcp();
        return { skillCount: report.total, skills: report.skills, diagnostics: report.diagnostics, mcpCount: mcp.servers.length, mcpServers: mcp.servers };
      },
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
