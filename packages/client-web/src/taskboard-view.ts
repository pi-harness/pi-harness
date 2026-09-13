export type TaskboardStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "canceled" | "done";
export type TaskboardPriority = "low" | "medium" | "high" | "urgent";

export interface TaskboardTaskView {
  readonly id: string;
  readonly key: string;
  readonly workspace: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskboardStatus;
  readonly priority: TaskboardPriority;
  readonly dueDate?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly dependsOn: readonly string[];
}

export interface TaskboardPanelView {
  readonly workspace: string;
  readonly total: number;
  readonly counts: Readonly<Record<TaskboardStatus, number>>;
  readonly recent: readonly TaskboardTaskView[];
  readonly lastError?: string;
  readonly malformed: boolean;
}

const statuses = ["backlog", "todo", "in_progress", "in_review", "blocked", "canceled", "done"] as const;
const priorities = new Set<TaskboardPriority>(["low", "medium", "high", "urgent"]);
const rootKeys = new Set(["workspace", "total", "counts", "recent", "lastError"]);
const requiredRootKeys = new Set(["workspace", "total", "counts", "recent"]);
const countKeys = new Set(statuses);
const taskKeys = new Set(["id", "key", "workspace", "title", "description", "status", "priority", "dueDate", "createdAt", "updatedAt", "version", "dependsOn"]);
const requiredTaskKeys = new Set([...taskKeys].filter((key) => key !== "dueDate"));
const maxDescriptionBytes = 16 * 1024;
const maxRecent = 8;

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

function hasRequired(source: Record<string, unknown>, required: ReadonlySet<string>, allowed: ReadonlySet<string>): boolean {
  const own = Object.keys(source);
  return own.length >= required.size && own.every((key) => allowed.has(key)) && [...required].every((key) => own.includes(key));
}

function safeInteger(value: unknown, minimum = 0): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

function safeText(value: unknown, maximum: number, allowEmpty = false, allowOuterWhitespace = false): string | undefined {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) return undefined;
  if (!allowEmpty && (value.trim().length === 0 || (!allowOuterWhitespace && value !== value.trim()))) return undefined;
  return value;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function dueDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? value : undefined;
}

function taskKey(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 32 && /^[A-Z][A-Z0-9_-]{1,11}-[1-9]\d*$/u.test(value) ? value : undefined;
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
        (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= (length as number) || String(Number(key)) !== key),
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

function taskView(value: unknown, workspace: string): TaskboardTaskView | undefined {
  const source = ownDataRecord(value, taskKeys);
  if (source === undefined) return undefined;
  const expectedKeys = source.dueDate === undefined ? requiredTaskKeys : taskKeys;
  if (!hasExactly(source, expectedKeys)) return undefined;
  const id = safeText(source.id, 128);
  const key = taskKey(source.key);
  const taskWorkspace = safeText(source.workspace, 4_096, false, true);
  const title = safeText(source.title, 200);
  const description = safeText(source.description, maxDescriptionBytes, true);
  const createdAt = timestamp(source.createdAt);
  const updatedAt = timestamp(source.updatedAt);
  const version = safeInteger(source.version, 1);
  const dependencies = ownDataArray(source.dependsOn, 32);
  if (
    id === undefined ||
    key === undefined ||
    taskWorkspace !== workspace ||
    title === undefined ||
    description === undefined ||
    new TextEncoder().encode(description).byteLength > maxDescriptionBytes ||
    !statuses.includes(source.status as TaskboardStatus) ||
    !priorities.has(source.priority as TaskboardPriority) ||
    createdAt === undefined ||
    updatedAt === undefined ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    version === undefined ||
    dependencies === undefined
  )
    return undefined;
  const dependsOn = dependencies.map(taskKey);
  if (dependsOn.some((dependency) => dependency === undefined) || new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(key)) return undefined;
  const normalizedDueDate = source.dueDate === undefined ? undefined : dueDate(source.dueDate);
  if (source.dueDate !== undefined && normalizedDueDate === undefined) return undefined;
  return {
    id,
    key,
    workspace: taskWorkspace,
    title,
    description,
    status: source.status as TaskboardStatus,
    priority: source.priority as TaskboardPriority,
    ...(normalizedDueDate === undefined ? {} : { dueDate: normalizedDueDate }),
    createdAt,
    updatedAt,
    version,
    dependsOn: dependsOn as string[],
  };
}

function malformedView(): TaskboardPanelView {
  return {
    workspace: "",
    total: 0,
    counts: { backlog: 0, todo: 0, in_progress: 0, in_review: 0, blocked: 0, canceled: 0, done: 0 },
    recent: [],
    malformed: true,
  };
}

export function taskboardPanelView(data: unknown): TaskboardPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !hasRequired(source, requiredRootKeys, rootKeys)) return malformedView();
  const workspace = safeText(source.workspace, 4_096, false, true);
  const total = safeInteger(source.total);
  const rawCounts = ownDataRecord(source.counts, countKeys);
  const rawRecent = ownDataArray(source.recent, maxRecent);
  const lastError = source.lastError === undefined ? undefined : source.lastError === null ? undefined : safeText(source.lastError, 2_000);
  if (
    workspace === undefined ||
    total === undefined ||
    rawCounts === undefined ||
    !hasExactly(rawCounts, countKeys) ||
    rawRecent === undefined ||
    (source.lastError !== undefined && source.lastError !== null && lastError === undefined)
  )
    return malformedView();
  const counts = {} as Record<TaskboardStatus, number>;
  for (const status of statuses) {
    const count = safeInteger(rawCounts[status]);
    if (count === undefined) return malformedView();
    counts[status] = count;
  }
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== total || rawRecent.length !== Math.min(total, maxRecent)) return malformedView();
  const recent = rawRecent.map((task) => taskView(task, workspace));
  if (recent.some((task) => task === undefined)) return malformedView();
  const tasks = recent as TaskboardTaskView[];
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length || new Set(tasks.map((task) => task.key)).size !== tasks.length) return malformedView();
  const recentCounts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<TaskboardStatus, number>;
  for (const task of tasks) {
    recentCounts[task.status] += 1;
    if (recentCounts[task.status] > counts[task.status]) return malformedView();
  }
  for (let index = 1; index < tasks.length; index += 1) {
    const previous = tasks[index - 1];
    const current = tasks[index];
    const previousTime = Date.parse(previous.updatedAt);
    const currentTime = Date.parse(current.updatedAt);
    if (previousTime < currentTime || (previousTime === currentTime && previous.key < current.key)) return malformedView();
  }
  return { workspace, total, counts, recent: tasks, ...(lastError === undefined ? {} : { lastError }), malformed: false };
}
