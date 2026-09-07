import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "@pi-harness/plugin-api";

const customType = "pi-harness/colleague-handoff";
const maxRoleLength = 128;
const maxObjectiveLength = 4_000;
const maxContextLength = 4_000;
const maxListTextLength = 1_000;
const maxFileLength = 4_096;
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

function boundedText(value: unknown, field: string, maximum: number, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (required && text.length === 0) throw new Error(`${field} is required`);
  if (text.length > maximum) throw new Error(`${field} must be ${maximum} characters or fewer`);
  if (text.includes("\0")) throw new Error(`${field} must not contain null bytes`);
  return text;
}

function boundedList(values: unknown, field: string, itemMaximum: number): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  if (values.length > maxListItems) throw new Error(`${field} must contain ${maxListItems} items or fewer`);
  return values.map((value) => boundedText(value, `${field} item`, itemMaximum, true));
}

export function createColleagueHandoff(input: unknown, id: string, createdAt: string): ColleagueHandoff {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Handoff input must be an object");
  const value = input as Record<string, unknown>;
  const toRole = boundedText(value.toRole, "toRole", maxRoleLength, true);
  const objective = boundedText(value.objective, "objective", maxObjectiveLength, true);
  const validatedId = boundedText(id, "handoff id", 128, true);
  const validatedCreatedAt = boundedText(createdAt, "createdAt", 64, true);
  if (!Number.isFinite(Date.parse(validatedCreatedAt))) throw new Error("createdAt must be a valid timestamp");
  return {
    id: validatedId,
    toRole,
    objective,
    context: boundedText(value.context, "context", maxContextLength),
    constraints: boundedList(value.constraints, "constraints", maxListTextLength),
    files: boundedList(value.files, "files", maxFileLength),
    acceptance: boundedList(value.acceptance, "acceptance", maxListTextLength),
    createdAt: validatedCreatedAt,
  };
}

function readLatest(context: Context): ColleagueHandoff | undefined {
  const entries = context.piSession.manager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== customType || entry.data === null || typeof entry.data !== "object") continue;
    const value = entry.data as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.createdAt !== "string") continue;
    try {
      return createColleagueHandoff(value, value.id, value.createdAt);
    } catch {
      continue;
    }
  }
  return undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Colleague handoff was cancelled", { cause: signal.reason });
}

export default {
  name: "pi-colleague-skill",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    let latest = readLatest(context);
    const unregister = context.piTools.register(
      defineTool({
        name: "colleague_handoff",
        label: "Colleague handoff",
        description: "Create a durable, structured handoff packet for another role without starting a hidden agent or sending external messages.",
        promptSnippet: "prepare a structured handoff for a colleague role",
        parameters: Type.Object(
          {
            toRole: Type.String({ description: "Receiving role, for example reviewer or frontend", minLength: 1, maxLength: maxRoleLength }),
            objective: Type.String({ description: "The concrete outcome the colleague should deliver", minLength: 1, maxLength: maxObjectiveLength }),
            context: Type.Optional(Type.String({ maxLength: maxContextLength })),
            constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: maxListTextLength }), { maxItems: maxListItems })),
            files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: maxFileLength }), { maxItems: maxListItems })),
            acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: maxListTextLength }), { maxItems: maxListItems })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute(_toolCallId, params, signal): Promise<AgentToolResult<ColleagueHandoff>> {
          return Promise.resolve().then(() => {
            const actionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            throwIfAborted(actionSignal);
            const handoff = createColleagueHandoff(params, `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`, new Date().toISOString());
            context.piSession.manager.appendCustomEntry(customType, structuredClone(handoff));
            latest = handoff;
            return {
              content: [{ type: "text" as const, text: `Handoff ${handoff.id} prepared for ${handoff.toRole}.` }],
              details: structuredClone(handoff),
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
      read: () => ({ latest: latest === undefined ? null : structuredClone(latest) }),
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("Colleague Skill plugin disposed"));
      unregister();
      disposePanel();
    });
  },
};
