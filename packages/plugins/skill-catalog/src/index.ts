import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, readBoundedTextFile, type PiMcpServerSnapshot } from "@pi-harness/plugin-api";
import { buildSkillInjection, type SkillInjection } from "@pi-harness/plugin-reverse-skill";

const maxQueryLength = 120;
const maxSkillBytes = 128 * 1024;
const maxItems = 200;
const maxDiagnostics = 100;

export interface SkillCatalogItem {
  name: string;
  description: string;
  filePath: string;
  source: string;
  scope: string;
  modelInvocationDisabled: boolean;
}

export interface SkillCatalogReport {
  total: number;
  loaded: number;
  truncated: boolean;
  diagnosticCount: number;
  skills: SkillCatalogItem[];
  diagnostics: Array<{ type: string; message: string }>;
}

export function prepareSkillRead(name: string, content: string): SkillInjection {
  return buildSkillInjection(content, name);
}

function parameters(value: unknown): { action: "list" | "read" | "mcp"; query?: string; name?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill catalog parameters must be an object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !["action", "query", "name"].includes(key)))
    throw new Error("Unknown skill catalog parameter");
  if (Object.values(descriptors).some((item) => !("value" in item))) throw new Error("Skill catalog parameters must use data properties");
  const action: unknown = descriptors.action?.value;
  if (action !== "list" && action !== "read" && action !== "mcp") throw new Error("Invalid skill catalog action");
  const query: unknown = descriptors.query?.value,
    name: unknown = descriptors.name?.value;
  if (query !== undefined && (typeof query !== "string" || query.length > maxQueryLength || query.includes("\0")))
    throw new Error("Invalid skill catalog query");
  if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.length > 64 || name.includes("\0")))
    throw new Error("Invalid skill catalog name");
  if ((action !== "list" && "query" in descriptors) || (action !== "read" && "name" in descriptors))
    throw new Error("Parameter does not apply to this skill catalog action");
  if (action === "read" && typeof name !== "string") throw new Error("Skill name is required");
  return { action, ...(typeof query === "string" ? { query: query.trim().toLowerCase() } : {}), ...(typeof name === "string" ? { name: name.trim() } : {}) };
}

function currentLoader(context: Context) {
  return context.get("piRuntime")?.session.resourceLoader ?? context.piResources.resourceLoader;
}

function readCatalog(context: Context, query = ""): SkillCatalogReport {
  const loaded = currentLoader(context).getSkills();
  const skills: SkillCatalogItem[] = [];
  let total = 0,
    truncated = false;
  const bounded = (value: string, maximum: number): string => {
    if (value.length > maximum) truncated = true;
    return value.slice(0, maximum);
  };
  for (const skill of loaded.skills) {
    if (query !== "" && !`${skill.name} ${skill.description} ${skill.sourceInfo.source}`.toLowerCase().includes(query)) continue;
    total += 1;
    if (skills.length >= maxItems) {
      truncated = true;
      continue;
    }
    skills.push({
      name: bounded(skill.name, 64),
      description: bounded(skill.description, 2000),
      filePath: bounded(skill.filePath, 4096),
      source: bounded(skill.sourceInfo.source, 256),
      scope: bounded(skill.sourceInfo.scope, 64),
      modelInvocationDisabled: skill.disableModelInvocation,
    });
  }
  const diagnostics = loaded.diagnostics.slice(0, maxDiagnostics).map((item) => ({ type: bounded(item.type, 64), message: bounded(item.message, 2000) }));
  return {
    total,
    loaded: loaded.skills.length,
    skills,
    diagnostics,
    diagnosticCount: loaded.diagnostics.length,
    truncated: truncated || loaded.diagnostics.length > diagnostics.length,
  };
}

type McpStatus = Pick<PiMcpServerSnapshot, "id" | "status" | "startedAt">;
interface McpReport {
  available: boolean;
  total: number;
  servers: McpStatus[];
  truncated: boolean;
}

export default {
  name: "pi-skill-catalog",
  inject: ["piResources", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const readMcp = (): McpReport => {
      const service = context.get("piMcp");
      if (service === undefined) return { available: false, total: 0, truncated: false, servers: [] };
      const snapshot = service.snapshot();
      return {
        available: true,
        total: snapshot.servers.length,
        truncated: snapshot.servers.length > 100 || snapshot.servers.some((server) => server.id.length > 128 || server.status.length > 64),
        servers: snapshot.servers
          .slice(0, 100)
          .map((server) => ({ id: server.id.slice(0, 128), status: server.status.slice(0, 64), startedAt: server.startedAt })),
      };
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "skill_catalog",
        label: "Skill catalog",
        description:
          "Inspect loaded Agent Skills, inspect one skill file through a bounded heuristic data boundary, and inspect MCP status without changing configuration.",
        promptSnippet: "inspect loaded skills or managed MCP server status",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("mcp")]),
            query: Type.Optional(Type.String({ maxLength: maxQueryLength })),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, raw, signal): Promise<AgentToolResult<SkillCatalogReport | SkillInjection | McpReport>> {
          const combined = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const checkCancelled = (): void => {
            if (combined.aborted) throw new Error("Skill catalog was cancelled");
          };
          checkCancelled();
          const params = parameters(raw);
          if (params.action === "mcp") {
            const result = readMcp();
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
          if (params.action === "list") {
            const report = readCatalog(context, params.query);
            return { content: [{ type: "text", text: JSON.stringify(report) }], details: report };
          }
          const loader = currentLoader(context);
          const skills = loader.getSkills().skills;
          const name = params.name!;
          const skill = skills.find((candidate) => candidate.name === name);
          if (skill === undefined) throw new Error(`Skill was not found: ${name}`);
          const filePath = skill.filePath;
          const content = await readBoundedTextFile(filePath, maxSkillBytes, "Skill file");
          checkCancelled();
          if (
            currentLoader(context) !== loader ||
            loader.getSkills().skills !== skills ||
            !skills.includes(skill) ||
            skill.name !== name ||
            skill.filePath !== filePath
          )
            throw new Error("Loaded skill changed during catalog read");
          const result = prepareSkillRead(name, content);
          const message =
            result.content === null
              ? JSON.stringify({
                  name: result.name,
                  risk: result.risk,
                  score: result.score,
                  findings: result.findings,
                  message: "Source withheld by heuristic checks; this is not proof of safety.",
                })
              : result.content;
          return { content: [{ type: "text", text: message }], details: result };
        },
      }),
    );
    context.effect(() => unregister);
    const disposePanel = context.piPluginUi.register({
      id: "skill-catalog-panel",
      pluginId: "@pi-harness/plugin-skill-catalog",
      title: "Skills Catalog",
      description: "查看当前运行时加载的 Skills 与 MCP 服务器状态。",
      icon: "✦",
      read: () => {
        const report = readCatalog(context);
        const mcp = readMcp();
        return {
          skillCount: report.total,
          skills: report.skills,
          diagnostics: report.diagnostics,
          diagnosticCount: report.diagnosticCount,
          truncated: report.truncated || mcp.truncated,
          mcpCount: mcp.total,
          mcpAvailable: mcp.available,
          mcpServers: mcp.servers,
        };
      },
    });
    context.effect(() => disposePanel);
  },
};
