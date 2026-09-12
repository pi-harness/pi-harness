export interface MemoryItemView {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemorySearchPanelView {
  readonly query: string;
  readonly total: number;
  readonly shown: number;
  readonly truncated: boolean;
  readonly memories: readonly MemoryItemView[];
}

export interface MemoryPanelView {
  readonly filePath: string;
  readonly count: number;
  readonly shown: number;
  readonly truncated: boolean;
  readonly last: MemorySearchPanelView | null;
  readonly memories: readonly MemoryItemView[];
  readonly malformed: boolean;
}

const maxEntries = 500;
const maxPanelMemories = 8;
const rootKeys = new Set(["filePath", "count", "shown", "truncated", "last", "memories"]);
const searchKeys = new Set(["query", "total", "shown", "truncated", "memories"]);
const inventoryKeys = new Set(["total", "shown", "truncated", "memories"]);
const memoryKeys = new Set(["id", "key", "value", "tags", "createdAt", "updatedAt"]);

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
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
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

function exactText(value: unknown, maximum: number): string | undefined {
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

function memoryView(value: unknown): MemoryItemView | undefined {
  const source = ownDataRecord(value, memoryKeys);
  if (source === undefined || !hasExactly(source, memoryKeys)) return undefined;
  const id = exactText(source.id, 128);
  const key = exactText(source.key, 128);
  const storedValue = typeof source.value === "string" && source.value.length <= 64 * 1024 && source.value.trim().length > 0 ? source.value : undefined;
  const tagsRaw = ownDataArray(source.tags, 16);
  const createdAt = timestamp(source.createdAt);
  const updatedAt = timestamp(source.updatedAt);
  if (
    id === undefined ||
    key === undefined ||
    storedValue === undefined ||
    new TextEncoder().encode(storedValue).byteLength > 64 * 1024 ||
    tagsRaw === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    updatedAt.milliseconds < createdAt.milliseconds
  )
    return undefined;
  const tags = tagsRaw.map((tag) => exactText(tag, 64));
  if (tags.some((tag) => tag === undefined) || new Set(tags).size !== tags.length) return undefined;
  return { id, key, value: storedValue, tags: tags as string[], createdAt: createdAt.text, updatedAt: updatedAt.text };
}

function inventory(value: unknown, totalMaximum: number): Omit<MemorySearchPanelView, "query"> | undefined {
  const source = ownDataRecord(value, inventoryKeys);
  if (source === undefined || !hasExactly(source, inventoryKeys)) return undefined;
  const total = safeInteger(source.total, totalMaximum);
  const shown = safeInteger(source.shown, maxPanelMemories);
  const raw = ownDataArray(source.memories, maxPanelMemories);
  if (
    total === undefined ||
    shown === undefined ||
    raw === undefined ||
    typeof source.truncated !== "boolean" ||
    shown !== Math.min(total, maxPanelMemories) ||
    raw.length !== shown ||
    source.truncated !== total > shown
  )
    return undefined;
  const memories = raw.map(memoryView);
  if (memories.some((memory) => memory === undefined)) return undefined;
  const normalized = memories as MemoryItemView[];
  if (new Set(normalized.map((memory) => memory.id)).size !== normalized.length || new Set(normalized.map((memory) => memory.key)).size !== normalized.length)
    return undefined;
  if (normalized.some((memory, index) => index > 0 && Date.parse(normalized[index - 1].updatedAt) < Date.parse(memory.updatedAt))) return undefined;
  return { total, shown, truncated: source.truncated, memories: normalized };
}

function malformedView(): MemoryPanelView {
  return { filePath: "", count: 0, shown: 0, truncated: false, last: null, memories: [], malformed: true };
}

export function memoryPanelView(data: unknown): MemoryPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !hasExactly(source, rootKeys)) return malformedView();
  const filePath =
    typeof source.filePath === "string" && source.filePath.trim().length > 0 && source.filePath.length <= 4_096 && !source.filePath.includes("\0")
      ? source.filePath
      : undefined;
  const recent = inventory({ total: source.count, shown: source.shown, truncated: source.truncated, memories: source.memories }, maxEntries);
  if (filePath === undefined || recent === undefined) return malformedView();
  let last: MemorySearchPanelView | null = null;
  if (source.last !== null) {
    const lastSource = ownDataRecord(source.last, searchKeys);
    const lastInventory =
      lastSource === undefined
        ? undefined
        : inventory({ total: lastSource.total, shown: lastSource.shown, truncated: lastSource.truncated, memories: lastSource.memories }, maxEntries);
    const query = lastSource === undefined ? undefined : exactText(lastSource.query, 128);
    if (query === undefined || lastInventory === undefined) return malformedView();
    last = { query, ...lastInventory };
  }
  return {
    filePath,
    count: recent.total,
    shown: recent.shown,
    truncated: recent.truncated,
    last,
    memories: recent.memories,
    malformed: false,
  };
}
