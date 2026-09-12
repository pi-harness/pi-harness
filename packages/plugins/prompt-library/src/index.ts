import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "@pi-harness/plugin-api";

const customType = "pi-harness/prompt-library";
const maxTitleLength = 120;
const maxPromptLength = 8_000;
const maxTagLength = 40;
const maxTags = 10;
const maxTemplates = 100;
const maxPanelTemplates = 12;
const failedManagers = new WeakMap<object, object | null>();
const writeFailureMessage = "Prompt library write failed; reopen the session from disk before using the library again";

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

function bounded(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength.toLocaleString()} characters or fewer`);
  return text;
}

function ownDataArray(value: unknown, field: string, maximum: number): unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`Invalid ${field}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) throw new Error(`Invalid ${field}`);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= (length as number)),
    ) ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    throw new Error(`Invalid ${field}`);
  const output: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) throw new Error(`Invalid ${field}`);
    output.push(descriptor.value);
  }
  return output;
}

function normalizeTags(values: string[] | undefined): string[] {
  const tags = values === undefined ? [] : ownDataArray(values, "tags", maxTags);
  const normalized: string[] = [];
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    if (typeof tag !== "string") throw new Error("tags must contain string data properties");
    const normalizedTag = tag.trim();
    if (normalizedTag !== "") normalized.push(bounded(normalizedTag, "tag", maxTagLength));
  }
  return [...new Set(normalized)];
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

function ownRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) throw new Error("Prompt library data must be an object");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Prompt library data must be a plain object");
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !("value" in descriptors[key]!)) throw new Error("Prompt library data must use string data properties");
    output[key] = descriptors[key].value;
  }
  return output;
}

type Parameters = { action: "save" | "list" | "get" | "delete"; id?: string; title?: string; prompt?: string; tags?: string[]; query?: string };
function parameters(value: unknown): Parameters {
  const item = ownRecord(value);
  if (item.action !== "save" && item.action !== "list" && item.action !== "get" && item.action !== "delete") throw new Error("Unknown prompt library action");
  const allowed = item.action === "save" ? ["action", "id", "title", "prompt", "tags"] : item.action === "list" ? ["action", "query"] : ["action", "id"];
  if (Object.keys(item).some((key) => !allowed.includes(key))) throw new Error("Unknown property for prompt library action");
  for (const key of ["id", "title", "prompt", "query"] as const) {
    if (item[key] !== undefined && typeof item[key] !== "string") throw new Error(`${key} must be a string`);
  }
  if (item.id !== undefined) item.id = bounded(item.id, "id", 128);
  if (typeof item.query === "string" && item.query.length > 120) throw new Error("query must be 120 characters or fewer");
  if (item.tags !== undefined) item.tags = normalizeTags(item.tags as string[]);
  return item as Parameters;
}

function currentManager(context: Context) {
  return context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager;
}

function readState(context: Context): PromptLibraryState {
  const manager = currentManager(context);
  if (failedManagers.has(manager)) {
    if (failedManagers.get(manager) === manager.getHeader()) throw new Error(writeFailureMessage);
    failedManagers.delete(manager);
  }
  const entry = [...currentManager(context).getEntries()].reverse().find((item) => item.type === "custom" && item.customType === customType);
  if (entry === undefined) return { templates: [] };
  if (entry.type !== "custom") throw new Error("Invalid prompt library entry");
  const value = ownRecord(entry.data);
  const inventory = ownDataArray(value.templates, "prompt library inventory: expected at most 100 templates", maxTemplates);
  const ids = new Set<string>();
  const templates = inventory.map((item): PromptTemplate => {
    const candidate = ownRecord(item);
    if (!Array.isArray(candidate.tags)) throw new Error("Invalid prompt library tags");
    const id = bounded(candidate.id, "id", 128);
    if (ids.has(id)) throw new Error("Duplicate prompt library ID");
    ids.add(id);
    const createdAt = bounded(candidate.createdAt, "createdAt", 64);
    const updatedAt = bounded(candidate.updatedAt, "updatedAt", 64);
    const createdMilliseconds = Date.parse(createdAt);
    const updatedMilliseconds = Date.parse(updatedAt);
    if (
      !Number.isFinite(createdMilliseconds) ||
      !Number.isFinite(updatedMilliseconds) ||
      new Date(createdMilliseconds).toISOString() !== createdAt ||
      new Date(updatedMilliseconds).toISOString() !== updatedAt ||
      updatedMilliseconds < createdMilliseconds
    )
      throw new Error("Invalid prompt library timestamp");
    return {
      ...createPromptTemplate({ title: candidate.title as string, prompt: candidate.prompt as string, tags: candidate.tags as string[] }, id, createdAt),
      updatedAt,
    };
  });
  return { templates };
}

function persist(context: Context, state: PromptLibraryState): void {
  const manager = currentManager(context);
  try {
    manager.appendCustomEntry(customType, structuredClone(state));
  } catch (error) {
    failedManagers.set(manager, manager.getHeader());
    throw new Error(writeFailureMessage, { cause: error });
  }
}

function filterTemplates(state: PromptLibraryState, query: string | undefined): PromptTemplate[] {
  const normalized = query?.trim().toLocaleLowerCase() ?? "";
  if (!normalized) return state.templates;
  return state.templates.filter((template) => `${template.title} ${template.prompt} ${template.tags.join(" ")}`.toLocaleLowerCase().includes(normalized));
}

function nextTimestamp(state: PromptLibraryState): string {
  const previous = state.templates.reduce((latest, template) => Math.max(latest, Date.parse(template.updatedAt)), Number.NEGATIVE_INFINITY);
  const wallClock = Date.now();
  if (!Number.isFinite(wallClock)) throw new Error("Prompt library wall clock is invalid");
  const milliseconds = previous === Number.NEGATIVE_INFINITY ? wallClock : Math.max(wallClock, previous + 1);
  try {
    return new Date(milliseconds).toISOString();
  } catch (error) {
    throw new Error("Prompt library timestamp sequence is exhausted", { cause: error });
  }
}

export default {
  name: "pi-prompt-library",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const unregister = context.piTools.register(
      defineTool({
        name: "prompt_library",
        label: "Prompt library",
        description:
          "Save, search, retrieve, update, and delete reusable prompt templates in the current Pi session. Use list to find IDs, then get with an id to read the full template text.",
        promptSnippet: "manage reusable prompts for the current project",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("get"), Type.Literal("delete")]),
            id: Type.Optional(Type.String()),
            title: Type.Optional(Type.String()),
            prompt: Type.Optional(Type.String()),
            tags: Type.Optional(Type.Array(Type.String())),
            query: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<PromptLibraryState & { selected?: PromptTemplate }>> {
          if (signal?.aborted === true || lifecycle.signal.aborted) throw new Error("Prompt library request was cancelled");
          const manager = currentManager(context);
          const header = manager.getHeader();
          return Promise.resolve().then(() => {
            if (signal?.aborted === true || lifecycle.signal.aborted) throw new Error("Prompt library request was cancelled");
            if (currentManager(context) !== manager || manager.getHeader() !== header) throw new Error("Prompt library session changed before execution");
            const params = parameters(rawParams);
            const state = readState(context);
            if (params.action === "get") {
              if (!params.id) throw new Error("id is required when action is get");
              const selected = state.templates.find((template) => template.id === params.id);
              if (!selected) throw new Error(`Prompt was not found: ${params.id}`);
              return {
                content: [{ type: "text" as const, text: selected.prompt }],
                details: structuredClone({ templates: [selected], selected }),
              };
            }
            if (params.action === "save") {
              const now = nextTimestamp(state);
              const existing = params.id?.trim() ? state.templates.find((template) => template.id === params.id?.trim()) : undefined;
              if (params.id !== undefined && existing === undefined) throw new Error(`Prompt was not found: ${params.id}`);
              if (existing === undefined && state.templates.length >= maxTemplates)
                throw new Error("Prompt library contains 100 templates; delete one before adding another");
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
                    `prompt-${randomUUID()}`,
                    now,
                  );
              const templates = existing ? [...state.templates.filter((item) => item.id !== existing.id), template] : [...state.templates, template];
              const latest = { templates };
              persist(context, latest);
              return {
                content: [{ type: "text" as const, text: `Prompt ${template.id} saved.` }],
                details: structuredClone({ ...latest, selected: template }),
              };
            }
            if (params.action === "delete") {
              const id = params.id?.trim();
              if (!id) throw new Error("id is required when action is delete");
              if (!state.templates.some((template) => template.id === id)) throw new Error(`Prompt was not found: ${id}`);
              const latest = { templates: state.templates.filter((template) => template.id !== id) };
              persist(context, latest);
              return { content: [{ type: "text" as const, text: `Prompt ${id} deleted.` }], details: structuredClone(latest) };
            }
            const templates = filterTemplates(state, params.query);
            return {
              content: [{ type: "text" as const, text: templates.map((template) => `${template.id}: ${template.title}`).join("\n") || "No prompts found." }],
              details: structuredClone({ templates }),
            };
          });
        },
      }),
    );
    context.effect(() => unregister);
    const disposePanel = context.piPluginUi.register({
      id: "prompt-library-panel",
      pluginId: "@pi-harness/plugin-prompt-library",
      title: "Prompt Library",
      description: "保存和检索可复用的提示词模板，数据跟随当前会话。",
      icon: "✎",
      read: () => {
        const state = readState(context);
        const templates = state.templates
          .map((template, index) => ({ template, index }))
          .sort((left, right) => Date.parse(right.template.updatedAt) - Date.parse(left.template.updatedAt) || right.index - left.index)
          .slice(0, maxPanelTemplates)
          .map(({ template }) => template);
        return { total: state.templates.length, shown: templates.length, truncated: state.templates.length > templates.length, templates };
      },
    });
    context.effect(() => disposePanel);
  },
};
