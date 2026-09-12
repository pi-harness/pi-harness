export interface PromptLibraryTemplateView {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PromptLibraryPanelView {
  readonly total: number;
  readonly shown: number;
  readonly truncated: boolean;
  readonly templates: readonly PromptLibraryTemplateView[];
  readonly malformed: boolean;
}

const maxTemplates = 100;
const maxPanelTemplates = 12;
const rootKeys = new Set(["total", "shown", "truncated", "templates"]);
const templateKeys = new Set(["id", "title", "prompt", "tags", "createdAt", "updatedAt"]);

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function hasExactly(source: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const own = Object.keys(source);
  return own.length === keys.size && own.every((key) => keys.has(key));
}

function ownDataArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) return undefined;
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= (length as number)),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function safeInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function safeText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() ? value : undefined;
}

function timestamp(value: unknown): { text: string; milliseconds: number } | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString() === value ? { text: value, milliseconds } : undefined;
  } catch {
    return undefined;
  }
}

function templateView(value: unknown): PromptLibraryTemplateView | undefined {
  const source = ownDataRecord(value, templateKeys);
  if (source === undefined || !hasExactly(source, templateKeys)) return undefined;
  const id = safeText(source.id, 128);
  const title = safeText(source.title, 120);
  const prompt = safeText(source.prompt, 8_000);
  const tagsRaw = ownDataArray(source.tags, 10);
  const createdAt = timestamp(source.createdAt);
  const updatedAt = timestamp(source.updatedAt);
  if (id === undefined || title === undefined || prompt === undefined || tagsRaw === undefined || createdAt === undefined || updatedAt === undefined)
    return undefined;
  const tags = tagsRaw.map((tag) => safeText(tag, 40));
  if (tags.some((tag) => tag === undefined) || new Set(tags).size !== tags.length || updatedAt.milliseconds < createdAt.milliseconds) return undefined;
  return { id, title, prompt, tags: tags as string[], createdAt: createdAt.text, updatedAt: updatedAt.text };
}

function malformedView(): PromptLibraryPanelView {
  return { total: 0, shown: 0, truncated: false, templates: [], malformed: true };
}

export function promptLibraryPanelView(data: unknown): PromptLibraryPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !hasExactly(source, rootKeys)) return malformedView();
  const total = safeInteger(source.total, maxTemplates);
  const shown = safeInteger(source.shown, maxPanelTemplates);
  const templatesRaw = ownDataArray(source.templates, maxPanelTemplates);
  if (
    total === undefined ||
    shown === undefined ||
    templatesRaw === undefined ||
    typeof source.truncated !== "boolean" ||
    shown !== Math.min(total, maxPanelTemplates) ||
    templatesRaw.length !== shown ||
    source.truncated !== total > shown
  )
    return malformedView();
  const templates = templatesRaw.map(templateView);
  if (templates.some((template) => template === undefined)) return malformedView();
  const normalized = templates as PromptLibraryTemplateView[];
  if (new Set(normalized.map((template) => template.id)).size !== normalized.length) return malformedView();
  for (let index = 1; index < normalized.length; index += 1) {
    if (Date.parse(normalized[index - 1].updatedAt) < Date.parse(normalized[index].updatedAt)) return malformedView();
  }
  return { total, shown, truncated: source.truncated, templates: normalized, malformed: false };
}
