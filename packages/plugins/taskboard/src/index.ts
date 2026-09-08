import { randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

const defaultFileName = "taskboard.sqlite";
const maxTitleLength = 200;
const maxDescriptionBytes = 16 * 1024;
const maxQueryLength = 160;
const maxTasksPerList = 100;

type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "canceled" | "done";
type TaskPriority = "low" | "medium" | "high" | "urgent";
type Task = {
  id: string;
  key: string;
  workspace: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  dependsOn: string[];
};
type TaskReport = { workspace: string; truncated: boolean; status?: TaskStatus; query?: string; total: number; tasks: Task[] };
type TaskboardPanel = { workspace: string; total: number; counts: Record<TaskStatus, number>; recent: Task[] };

export interface TaskboardPluginConfig {
  fileName?: string;
  keyPrefix?: string;
}

export const Config: z<TaskboardPluginConfig> = z.object({
  fileName: z.string().default(defaultFileName),
  keyPrefix: z.string().default("PIH"),
});

const statuses: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked", "canceled", "done"];
const priorities: readonly TaskPriority[] = ["low", "medium", "high", "urgent"];

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && statuses.includes(value as TaskStatus);
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && priorities.includes(value as TaskPriority);
}

function normalizeFilePath(agentDir: string, fileName: string | undefined): string {
  const name = (fileName ?? defaultFileName).trim();
  if (name === "" || basename(name) !== name || !/\.(?:sqlite|db)$/iu.test(name))
    throw new Error("Taskboard fileName must be a single .sqlite or .db filename");
  return resolve(agentDir, name);
}

function normalizeText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) throw new Error(`${field} must contain 1-${maxLength} characters`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new Error(`${field} must contain 1-${maxLength} characters`);
  return normalized;
}

function normalizeDescription(value: string | undefined): string {
  if (value !== undefined && (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxDescriptionBytes))
    throw new Error("Invalid Taskboard description");
  const normalized = value?.trim() ?? "";
  if (Buffer.byteLength(normalized, "utf8") > maxDescriptionBytes) throw new Error(`Taskboard description must be at most ${maxDescriptionBytes} bytes`);
  return normalized;
}

function normalizeDueDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length !== 10) throw new Error("Taskboard dueDate must use YYYY-MM-DD");
  const normalized = value;
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(normalized) ||
    !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`)) ||
    new Date(`${normalized}T00:00:00Z`).toISOString().slice(0, 10) !== normalized
  )
    throw new Error("Taskboard dueDate must use YYYY-MM-DD");
  return normalized;
}

function normalizeKeyPrefix(value: string | undefined): string {
  const normalized = (value ?? "PIH").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,11}$/u.test(normalized)) throw new Error("Taskboard keyPrefix must contain 2-12 letters, numbers, _ or -");
  return normalized;
}

function taskFromRow(database: DatabaseSync, row: Record<string, unknown>): Task {
  if (
    typeof row.id !== "string" ||
    typeof row.task_key !== "string" ||
    typeof row.workspace !== "string" ||
    typeof row.title !== "string" ||
    typeof row.description !== "string" ||
    !isTaskStatus(row.status) ||
    !isTaskPriority(row.priority) ||
    (row.due_date !== null && typeof row.due_date !== "string") ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.version !== "number"
  )
    throw new Error("Taskboard database contains an invalid task row");
  return {
    id: row.id,
    key: row.task_key,
    workspace: row.workspace,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    ...(row.due_date === null ? {} : { dueDate: row.due_date }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    dependsOn: (
      database.prepare("SELECT prerequisite_key FROM task_dependencies WHERE task_key = ? ORDER BY prerequisite_key").all(row.task_key) as Array<{
        prerequisite_key: string;
      }>
    ).map((item) => item.prerequisite_key),
  };
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function prepareDatabasePath(filePath: string): Promise<{ dev: number; ino: number }> {
  try {
    const handle = await open(filePath, "wx", 0o600);
    try {
      const metadata = await handle.stat();
      return { dev: metadata.dev, ino: metadata.ino };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error;
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) throw new Error("Taskboard database must be a regular file and cannot be a symbolic link", { cause: error });
    return { dev: metadata.dev, ino: metadata.ino };
  }
}

export default {
  name: "pi-taskboard",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: TaskboardPluginConfig) {
    const filePath = normalizeFilePath(context.piHarnessLaunch.agentDir, config.fileName);
    assertKnownConfigKeys("pi-taskboard", config, ["fileName", "keyPrefix"]);
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const currentManager = () => context.get("piRuntime")?.session.sessionManager;
    const capture = (signal?: AbortSignal) => {
      if (lifecycle.signal.aborted || signal?.aborted) throw new Error("Taskboard operation was cancelled");
      const manager = currentManager();
      const workspace = resolve(manager?.getCwd() ?? context.piHarnessLaunch.cwd);
      const id = manager?.getSessionId();
      const check = () => {
        if (lifecycle.signal.aborted || signal?.aborted) throw new Error("Taskboard operation was cancelled");
        if (currentManager() !== manager || manager?.getSessionId() !== id || resolve(manager?.getCwd() ?? context.piHarnessLaunch.cwd) !== workspace)
          throw new Error("Taskboard context changed during execution");
      };
      return { workspace, check };
    };
    const validate = (params: unknown, allowed: string[]) => {
      if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("Taskboard parameters must be an object");
      const descriptors = Object.getOwnPropertyDescriptors(params);
      if (
        Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key)) ||
        Object.values(descriptors).some((entry) => !("value" in entry))
      )
        throw new Error("Invalid Taskboard parameter");
    };
    const keyPrefix = normalizeKeyPrefix(config.keyPrefix);
    let writeQueue = Promise.resolve();

    const withDatabase = async <T>(check: () => void, operation: (database: DatabaseSync) => T): Promise<T> => {
      check();
      await mkdir(dirname(filePath), { recursive: true });
      check();
      const expected = await prepareDatabasePath(filePath);
      check();
      const database = new DatabaseSync(filePath, { timeout: 1000 });
      try {
        const actual = await lstat(filePath);
        if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino)
          throw new Error("Taskboard database must remain the same regular file while opening");
        check();
        database.exec(`
          PRAGMA foreign_keys = ON;
          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            task_key TEXT NOT NULL UNIQUE,
            workspace TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','canceled','done')),
            priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
            due_date TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS task_dependencies (
            task_key TEXT NOT NULL REFERENCES tasks(task_key),
            prerequisite_key TEXT NOT NULL REFERENCES tasks(task_key),
            PRIMARY KEY (task_key, prerequisite_key),
            CHECK (task_key <> prerequisite_key)
          );
          CREATE INDEX IF NOT EXISTS tasks_workspace_updated ON tasks(workspace, updated_at DESC);
          CREATE INDEX IF NOT EXISTS tasks_workspace_status ON tasks(workspace, status);
        `);
        return operation(database);
      } finally {
        database.close();
      }
    };

    const mutate = async <T>(check: () => void, operation: (database: DatabaseSync) => T): Promise<T> => {
      let result: T | undefined;
      const run = async (): Promise<void> => {
        result = await withDatabase(check, (database) => withTransaction(database, () => operation(database)));
      };
      writeQueue = writeQueue.catch(() => undefined).then(run);
      await writeQueue;
      return result as T;
    };

    const findTask = (database: DatabaseSync, workspace: string, key: string): Task | undefined => {
      const row = database.prepare("SELECT * FROM tasks WHERE workspace = ? AND task_key = ?").get(workspace, key) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : taskFromRow(database, row);
    };

    const dependencyKeys = (value: unknown): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string"))
        throw new Error("Taskboard dependsOn must contain at most 32 task keys");
      const keys = value.map((item) => normalizeText(item as string, "Dependency key", 32).toUpperCase());
      if (new Set(keys).size !== keys.length) throw new Error("Taskboard dependencies must be unique");
      return keys;
    };
    const setDependencies = (database: DatabaseSync, workspace: string, key: string, keys: string[]) => {
      for (const prerequisite of keys) {
        if (prerequisite === key) throw new Error("Taskboard dependency cycle is not allowed");
        if (findTask(database, workspace, prerequisite) === undefined) throw new Error(`Taskboard prerequisite not found in this workspace: ${prerequisite}`);
        const cycle = database
          .prepare(
            "WITH RECURSIVE ancestors(task_key) AS (SELECT ? UNION SELECT d.prerequisite_key FROM task_dependencies d JOIN ancestors a ON d.task_key = a.task_key) SELECT 1 FROM ancestors WHERE task_key = ? LIMIT 1",
          )
          .get(prerequisite, key);
        if (cycle !== undefined) throw new Error("Taskboard dependency cycle is not allowed");
      }
      database.prepare("DELETE FROM task_dependencies WHERE task_key = ?").run(key);
      for (const prerequisite of keys) database.prepare("INSERT INTO task_dependencies(task_key,prerequisite_key) VALUES (?,?)").run(key, prerequisite);
    };

    const createTool = defineTool({
      name: "taskboard_create",
      label: "Create taskboard task",
      description: "Create a local project task with a stable readable key and an explicit priority.",
      promptSnippet: "create a taskboard task for this workspace",
      parameters: Type.Object(
        {
          title: Type.String(),
          description: Type.Optional(Type.String()),
          priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("urgent")])),
          dueDate: Type.Optional(Type.String()),
          dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 32, uniqueItems: true })),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<Task>> {
        const { workspace, check } = capture(signal);
        validate(params, ["title", "description", "priority", "dueDate", "dependsOn"]);
        const title = normalizeText(params.title, "Taskboard title", maxTitleLength);
        const description = normalizeDescription(params.description);
        const priority = params.priority ?? "medium";
        if (!isTaskPriority(priority)) throw new Error("Invalid Taskboard priority");
        const dueDate = normalizeDueDate(params.dueDate);
        const dependsOn = dependencyKeys(params.dependsOn);
        const task = await mutate(check, (database) => {
          let lastNumber = 0;
          const pattern = new RegExp(`^${keyPrefix}-(\\d+)$`, "u");
          for (const row of database.prepare("SELECT task_key FROM tasks WHERE task_key LIKE ?").iterate(`${keyPrefix}-%`)) {
            const match = typeof row.task_key === "string" ? row.task_key.match(pattern) : null;
            if (match !== null) lastNumber = Math.max(lastNumber, Number(match[1]));
          }
          const nextNumber = lastNumber + 1;
          if (!Number.isSafeInteger(nextNumber)) throw new Error("Taskboard key sequence is exhausted");
          const now = new Date().toISOString();
          const next: Task = {
            id: randomUUID(),
            key: `${keyPrefix}-${nextNumber}`,
            workspace,
            title,
            description,
            status: "backlog",
            priority,
            ...(dueDate === undefined ? {} : { dueDate }),
            createdAt: now,
            updatedAt: now,
            version: 1,
            dependsOn: dependsOn ?? [],
          };
          database
            .prepare(
              "INSERT INTO tasks (id, task_key, workspace, title, description, status, priority, due_date, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              next.id,
              next.key,
              next.workspace,
              next.title,
              next.description,
              next.status,
              next.priority,
              next.dueDate ?? null,
              next.createdAt,
              next.updatedAt,
              next.version,
            );
          setDependencies(database, workspace, next.key, next.dependsOn);
          return next;
        });
        return { content: [{ type: "text", text: JSON.stringify(task) }], details: task };
      },
    });

    const listTool = defineTool({
      name: "taskboard_list",
      label: "List taskboard tasks",
      description: "List bounded local tasks for this workspace, optionally filtered by status or text.",
      promptSnippet: "list taskboard tasks for this workspace",
      parameters: Type.Object(
        {
          status: Type.Optional(
            Type.Union(statuses.map((status) => Type.Literal(status)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
          ),
          query: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<TaskReport>> {
        const { workspace, check } = capture(signal);
        validate(params, ["status", "query", "limit"]);
        const query = params.query === undefined ? undefined : normalizeText(params.query, "Taskboard query", maxQueryLength);
        const limit = params.limit ?? 20;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxTasksPerList) throw new Error("Taskboard limit must be an integer from 1 to 100");
        if (params.status !== undefined && !isTaskStatus(params.status)) throw new Error("Invalid Taskboard status");
        const report = await withDatabase(check, (database) => {
          const rows = database.prepare("SELECT * FROM tasks WHERE workspace = ? ORDER BY updated_at DESC, task_key DESC").iterate(workspace);
          const tasks: Task[] = [];
          let total = 0;
          const needle = query?.toLowerCase();
          for (const row of rows) {
            if (typeof row.task_key !== "string" || typeof row.title !== "string" || typeof row.description !== "string")
              throw new Error("Invalid Taskboard task text");
            if (params.status !== undefined && row.status !== params.status) continue;
            if (needle !== undefined && !`${row.task_key} ${row.title} ${row.description}`.toLowerCase().includes(needle)) continue;
            total += 1;
            if (tasks.length < limit) tasks.push(taskFromRow(database, row));
          }
          return {
            ...(params.status === undefined ? {} : { status: params.status as TaskStatus }),
            ...(query === undefined ? {} : { query }),
            workspace,
            total,
            tasks,
            truncated: total > tasks.length,
          } satisfies TaskReport;
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report),
            },
          ],
          details: report,
        };
      },
    });

    const updateTool = defineTool({
      name: "taskboard_update",
      label: "Update taskboard task",
      description: "Update task details or move a task through the agent-owned workflow; completion requires taskboard_accept.",
      promptSnippet: "update a taskboard task without bypassing completion review",
      parameters: Type.Object(
        {
          key: Type.String(),
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          status: Type.Optional(
            Type.Union(
              statuses.filter((status) => status !== "done").map((status) => Type.Literal(status)) as [
                ReturnType<typeof Type.Literal>,
                ...ReturnType<typeof Type.Literal>[],
              ],
            ),
          ),
          priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("urgent")])),
          dueDate: Type.Optional(Type.String()),
          dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 32, uniqueItems: true })),
          clearDueDate: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<Task>> {
        const { workspace, check } = capture(signal);
        validate(params, ["key", "title", "description", "status", "priority", "dueDate", "clearDueDate", "dependsOn"]);
        const key = normalizeText(params.key, "Taskboard key", 32).toUpperCase();
        if (params.status !== undefined && !isTaskStatus(params.status)) throw new Error("Invalid Taskboard status");
        if (params.priority !== undefined && !isTaskPriority(params.priority)) throw new Error("Invalid Taskboard priority");
        if (params.clearDueDate !== undefined && typeof params.clearDueDate !== "boolean") throw new Error("Invalid Taskboard clearDueDate");
        if (params.status === "done") throw new Error("Taskboard tasks must reach in_review before taskboard_accept can mark them done");
        if (
          params.title === undefined &&
          params.description === undefined &&
          params.status === undefined &&
          params.priority === undefined &&
          params.dueDate === undefined &&
          params.clearDueDate !== true &&
          params.dependsOn === undefined
        )
          throw new Error("Taskboard update requires at least one changed field");
        if (params.dueDate !== undefined && params.clearDueDate === true) throw new Error("Taskboard dueDate and clearDueDate cannot be used together");
        const title = params.title === undefined ? undefined : normalizeText(params.title, "Taskboard title", maxTitleLength);
        const description = params.description === undefined ? undefined : normalizeDescription(params.description);
        const dueDate = normalizeDueDate(params.dueDate);
        const dependsOn = dependencyKeys(params.dependsOn);
        const task = await mutate(check, (database) => {
          const current = findTask(database, workspace, key);
          if (current === undefined) throw new Error(`Taskboard task not found: ${key}`);
          if (current.status === "done" || current.status === "canceled") throw new Error(`Taskboard task ${key} is ${current.status} and cannot be updated`);
          const next: Task = {
            ...current,
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description }),
            ...(params.status === undefined ? {} : { status: params.status as TaskStatus }),
            ...(params.priority === undefined ? {} : { priority: params.priority }),
            ...(dueDate === undefined || params.clearDueDate === true ? {} : { dueDate }),
            updatedAt: new Date().toISOString(),
            version: current.version + 1,
            dependsOn: dependsOn ?? current.dependsOn,
          };
          if (params.clearDueDate === true) delete next.dueDate;
          database
            .prepare(
              "UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, due_date = ?, updated_at = ?, version = ? WHERE workspace = ? AND task_key = ? AND version = ?",
            )
            .run(next.title, next.description, next.status, next.priority, next.dueDate ?? null, next.updatedAt, next.version, workspace, key, current.version);
          if (dependsOn !== undefined) setDependencies(database, workspace, key, dependsOn);
          return next;
        });
        return { content: [{ type: "text", text: JSON.stringify(task) }], details: task };
      },
    });

    const acceptTool = defineTool({
      name: "taskboard_accept",
      label: "Accept taskboard task",
      description: "Accept a task in review as done after explicit confirmation.",
      promptSnippet: "accept a reviewed taskboard task as done",
      parameters: Type.Object({ key: Type.String(), confirm: Type.Boolean() }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<Task>> {
        const { workspace, check } = capture(signal);
        validate(params, ["key", "confirm"]);
        const key = normalizeText(params.key, "Taskboard key", 32).toUpperCase();
        if (params.confirm !== true) throw new Error("Accepting a task requires confirm=true");
        const task = await mutate(check, (database) => {
          const current = findTask(database, workspace, key);
          if (current === undefined) throw new Error(`Taskboard task not found: ${key}`);
          if (current.status !== "in_review") throw new Error(`Taskboard task ${key} must be in_review before acceptance`);
          const unfinished = database
            .prepare(
              "SELECT d.prerequisite_key FROM task_dependencies d JOIN tasks t ON t.task_key = d.prerequisite_key WHERE d.task_key = ? AND t.status <> 'done'",
            )
            .all(key);
          if (unfinished.length > 0) throw new Error("Taskboard prerequisites must be done before acceptance");
          const next = { ...current, status: "done" as const, updatedAt: new Date().toISOString(), version: current.version + 1 };
          database
            .prepare("UPDATE tasks SET status = ?, updated_at = ?, version = ? WHERE workspace = ? AND task_key = ? AND version = ?")
            .run("done", next.updatedAt, next.version, workspace, key, current.version);
          return next;
        });
        return { content: [{ type: "text", text: JSON.stringify(task) }], details: task };
      },
    });

    const disposers: Array<() => void> = [];
    try {
      disposers.push(context.piTools.register(createTool));
      disposers.push(context.piTools.register(listTool));
      disposers.push(context.piTools.register(updateTool));
      disposers.push(context.piTools.register(acceptTool));
      disposers.push(
        context.piPluginUi.register({
          id: "taskboard-panel",
          pluginId: "@pi-harness/plugin-taskboard",
          title: "Taskboard",
          description: "本工作区的本地任务、状态流转与验收队列。",
          icon: "▦",
          read: async (): Promise<TaskboardPanel> => {
            const { workspace, check } = capture();
            const report = await withDatabase(check, (database) => {
              const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<TaskStatus, number>;
              for (const row of database.prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE workspace = ? GROUP BY status").all(workspace)) {
                if (!isTaskStatus(row.status) || typeof row.count !== "number") throw new Error("Invalid Taskboard count");
                counts[row.status] = row.count;
              }
              const recent = database
                .prepare("SELECT * FROM tasks WHERE workspace = ? ORDER BY updated_at DESC, task_key DESC LIMIT 8")
                .all(workspace)
                .map((row) => taskFromRow(database, row));
              return { workspace, total: Object.values(counts).reduce((a, b) => a + b, 0), counts, recent };
            });
            return report;
          },
        }),
      );
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    context.effect(() => () => {
      for (const dispose of disposers.reverse()) dispose();
    });
  },
};
