import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const customType = "pi-harness/colleague-handoff";
const maxTextLength = 4_000;
const maxListItems = 20;

export interface ColleagueHandoffInput {
  toRole: string;
  objective: string;
  context?: string;
  constraints?: string[];
  files?: string[];
  acceptance?: string[];
}

export interface ColleagueHandoff {
  id: string;
  toRole: string;
  objective: string;
  context: string;
  constraints: string[];
  files: string[];
  acceptance: string[];
  createdAt: string;
}

function boundedText(value: string | undefined, field: string): string {
  const text = value?.trim() ?? "";
  if (text.length > maxTextLength) throw new Error(`${field} must be ${maxTextLength} characters or fewer`);
  return text;
}

function boundedList(values: string[] | undefined, field: string): string[] {
  const list = values ?? [];
  if (list.length > maxListItems) throw new Error(`${field} must contain ${maxListItems} items or fewer`);
  return list.map((value) => boundedText(value, `${field} item`)).filter(Boolean);
}

export function createColleagueHandoff(input: ColleagueHandoffInput, id: string, createdAt: string): ColleagueHandoff {
  const toRole = boundedText(input.toRole, "toRole");
  const objective = boundedText(input.objective, "objective");
  if (!toRole) throw new Error("toRole is required");
  if (!objective) throw new Error("objective is required");
  return {
    id,
    toRole,
    objective,
    context: boundedText(input.context, "context"),
    constraints: boundedList(input.constraints, "constraints"),
    files: boundedList(input.files, "files"),
    acceptance: boundedList(input.acceptance, "acceptance"),
    createdAt,
  };
}

function readLatest(context: Context): ColleagueHandoff | undefined {
  const entries = context.piSession.manager.getEntries();
  const entry = [...entries].reverse().find((item) => item.type === "custom" && item.customType === customType);
  if (entry?.type !== "custom" || entry.data === undefined || entry.data === null || typeof entry.data !== "object") return undefined;
  const value = entry.data as Partial<ColleagueHandoff>;
  if (typeof value.id !== "string" || typeof value.toRole !== "string" || typeof value.objective !== "string" || typeof value.createdAt !== "string")
    return undefined;
  return {
    id: value.id,
    toRole: value.toRole,
    objective: value.objective,
    context: typeof value.context === "string" ? value.context : "",
    constraints: Array.isArray(value.constraints) ? value.constraints.filter((item): item is string => typeof item === "string") : [],
    files: Array.isArray(value.files) ? value.files.filter((item): item is string => typeof item === "string") : [],
    acceptance: Array.isArray(value.acceptance) ? value.acceptance.filter((item): item is string => typeof item === "string") : [],
    createdAt: value.createdAt,
  };
}

export default {
  name: "pi-colleague-skill",
  inject: ["piSession", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest = readLatest(context);
    const unregister = context.piTools.register(
      defineTool({
        name: "colleague_handoff",
        label: "Colleague handoff",
        description: "Create a durable, structured handoff packet for another role without starting a hidden agent or sending external messages.",
        promptSnippet: "prepare a structured handoff for a colleague role",
        parameters: Type.Object({
          toRole: Type.String({ description: "Receiving role, for example reviewer or frontend" }),
          objective: Type.String({ description: "The concrete outcome the colleague should deliver" }),
          context: Type.Optional(Type.String()),
          constraints: Type.Optional(Type.Array(Type.String())),
          files: Type.Optional(Type.Array(Type.String())),
          acceptance: Type.Optional(Type.Array(Type.String())),
        }),
        execute(_toolCallId, params): Promise<AgentToolResult<ColleagueHandoff>> {
          return Promise.resolve().then(() => {
            const handoff = createColleagueHandoff(params, `handoff-${Date.now()}`, new Date().toISOString());
            context.piSession.manager.appendCustomEntry(customType, handoff);
            latest = handoff;
            return {
              content: [{ type: "text" as const, text: `Handoff ${handoff.id} prepared for ${handoff.toRole}.` }],
              details: handoff,
            };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "colleague-skill-panel",
      pluginId: "@pi-harness/core/plugins/colleague-skill",
      title: "Colleague Skill",
      description: "把任务、上下文、约束和验收条件整理成可追踪的角色交接包。",
      icon: "⇄",
      read: () => ({ latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
