import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const customType = "pi-harness/prompt-library";
const maxTitleLength = 120;
const maxPromptLength = 8_000;
const maxTagLength = 40;
const maxTags = 10;
const maxTemplates = 100;

export interface PromptTemplateInput {
  title: string;
  prompt: string;
  tags?: string[];
}

export interface PromptTemplate {
  id: string;
  title: string;
  prompt: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptLibraryState {
  templates: PromptTemplate[];
}

function bounded(value: string, field: string, maxLength: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength.toLocaleString()} characters or fewer`);
  return text;
}

function normalizeTags(values: string[] | undefined): string[] {
  const tags = values ?? [];
  if (tags.length > maxTags) throw new Error(`tags must contain ${maxTags} items or fewer`);
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].map((tag) => bounded(tag, "tag", maxTagLength));
}

export function createPromptTemplate(input: PromptTemplateInput, id: string, timestamp: string): PromptTemplate {
  return {
    id,
    title: bounded(input.title, "title", maxTitleLength),
    prompt: bounded(input.prompt, "prompt", maxPromptLength),
    tags: normalizeTags(input.tags),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function readState(context: Context): PromptLibraryState {
  const entry = [...context.piSession.manager.getEntries()].reverse().find((item) => item.type === "custom" && item.customType === customType);
  if (entry?.type !== "custom" || entry.data === undefined || entry.data === null || typeof entry.data !== "object") return { templates: [] };
  const value = entry.data as { templates?: unknown };
  if (!Array.isArray(value.templates)) return { templates: [] };
  const templates = value.templates.flatMap((item): PromptTemplate[] => {
    if (item === null || typeof item !== "object") return [];
    const candidate = item as Partial<PromptTemplate>;
    if (typeof candidate.id !== "string" || typeof candidate.title !== "string" || typeof candidate.prompt !== "string") return [];
    return [
      {
        id: candidate.id,
        title: candidate.title,
        prompt: candidate.prompt,
        tags: Array.isArray(candidate.tags) ? candidate.tags.filter((tag): tag is string => typeof tag === "string") : [],
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
      },
    ];
  });
  return { templates: templates.slice(-maxTemplates) };
}

function persist(context: Context, state: PromptLibraryState): void {
  context.piSession.manager.appendCustomEntry(customType, state);
}

function filterTemplates(state: PromptLibraryState, query: string | undefined): PromptTemplate[] {
  const normalized = query?.trim().toLocaleLowerCase() ?? "";
  if (!normalized) return state.templates;
  return state.templates.filter((template) => `${template.title} ${template.prompt} ${template.tags.join(" ")}`.toLocaleLowerCase().includes(normalized));
}

export default {
  name: "pi-prompt-library",
  inject: ["piSession", "piPluginUi", "piTools"],
  apply(context: Context) {
    let sequence = 0;
    let latest = readState(context);
    const unregister = context.piTools.register(
      defineTool({
        name: "prompt_library",
        label: "Prompt library",
        description: "Save, search, update, and delete reusable prompt templates in the current Pi session.",
        promptSnippet: "manage reusable prompts for the current project",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("delete")]),
          id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          prompt: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Array(Type.String())),
          query: Type.Optional(Type.String()),
        }),
        execute(_toolCallId, params): Promise<AgentToolResult<PromptLibraryState & { selected?: PromptTemplate }>> {
          return Promise.resolve().then(() => {
            const state = readState(context);
            if (params.action === "save") {
              const now = new Date().toISOString();
              const existing = params.id?.trim() ? state.templates.find((template) => template.id === params.id?.trim()) : undefined;
              const template = existing
                ? {
                    ...existing,
                    title: bounded(params.title ?? existing.title, "title", maxTitleLength),
                    prompt: bounded(params.prompt ?? existing.prompt, "prompt", maxPromptLength),
                    tags: normalizeTags(params.tags ?? existing.tags),
                    updatedAt: now,
                  }
                : createPromptTemplate(
                    { title: params.title ?? "", prompt: params.prompt ?? "", ...(params.tags === undefined ? {} : { tags: params.tags }) },
                    `prompt-${Date.now()}-${++sequence}`,
                    now,
                  );
              const templates = existing
                ? state.templates.map((item) => (item.id === existing.id ? template : item))
                : [...state.templates, template].slice(-maxTemplates);
              latest = { templates };
              persist(context, latest);
              return { content: [{ type: "text" as const, text: `Prompt ${template.id} saved.` }], details: { ...latest, selected: template } };
            }
            if (params.action === "delete") {
              const id = params.id?.trim();
              if (!id) throw new Error("id is required when action is delete");
              if (!state.templates.some((template) => template.id === id)) throw new Error(`Prompt was not found: ${id}`);
              latest = { templates: state.templates.filter((template) => template.id !== id) };
              persist(context, latest);
              return { content: [{ type: "text" as const, text: `Prompt ${id} deleted.` }], details: latest };
            }
            latest = state;
            const templates = filterTemplates(state, params.query);
            return {
              content: [{ type: "text" as const, text: templates.map((template) => `${template.id}: ${template.title}`).join("\n") || "No prompts found." }],
              details: { templates },
            };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "prompt-library-panel",
      pluginId: "@pi-harness/core/plugins/prompt-library",
      title: "Prompt Library",
      description: "保存和检索可复用的提示词模板，数据跟随当前会话。",
      icon: "✎",
      read: () => ({ total: latest.templates.length, templates: latest.templates }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
