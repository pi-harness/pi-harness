import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

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
};
type TaskReport = { status?: TaskStatus; query?: string; total: number; tasks: Task[] };
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
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new Error(`${field} must contain 1-${maxLength} characters`);
  return normalized;
}

function normalizeDescription(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (Buffer.byteLength(normalized, "utf8") > maxDescriptionBytes) throw new Error(`Taskboard description must be at most ${maxDescriptionBytes} bytes`);
  return normalized;
}

function normalizeDueDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized) || !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`)))
    throw new Error("Taskboard dueDate must use YYYY-MM-DD");
  return normalized;
}

function normalizeKeyPrefix(value: string | undefined): string {
  const normalized = (value ?? "PIH").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,11}$/u.test(normalized)) throw new Error("Taskboard keyPrefix must contain 2-12 letters, numbers, _ or -");
  return normalized;
}

function taskFromRow(row: Record<string, unknown>): Task {
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

export default {
  name: "pi-taskboard",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: TaskboardPluginConfig) {
    const filePath = normalizeFilePath(context.piHarnessLaunch.agentDir, config.fileName);
    const workspace = resolve(context.piHarnessLaunch.cwd);
    const keyPrefix = normalizeKeyPrefix(config.keyPrefix);
    let writeQueue = Promise.resolve();

    const withDatabase = async <T>(operation: (database: DatabaseSync) => T): Promise<T> => {
      await mkdir(dirname(filePath), { recursive: true });
      const database = new DatabaseSync(filePath);
      database.exec(`
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
        CREATE INDEX IF NOT EXISTS tasks_workspace_updated ON tasks(workspace, updated_at DESC);
        CREATE INDEX IF NOT EXISTS tasks_workspace_status ON tasks(workspace, status);
      `);
      try {
        return operation(database);
      } finally {
        database.close();
      }
    };

    const mutate = async <T>(operation: (database: DatabaseSync) => T): Promise<T> => {
      let result: T | undefined;
      const run = async (): Promise<void> => {
        result = await withDatabase((database) => withTransaction(database, () => operation(database)));
      };
      writeQueue = writeQueue.catch(() => undefined).then(run);
      await writeQueue;
      return result as T;
    };

    const findTask = (database: DatabaseSync, key: string): Task | undefined => {
      const row = database.prepare("SELECT * FROM tasks WHERE workspace = ? AND task_key = ?").get(workspace, key) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : taskFromRow(row);
    };

    const createTool = defineTool({
      name: "taskboard_create",
      label: "Create taskboard task",
      description: "Create a local project task with a stable readable key and an explicit priority.",
      promptSnippet: "create a taskboard task for this workspace",
      parameters: Type.Object({
        title: Type.String(),
        description: Type.Optional(Type.String()),
        priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("urgent")])),
        dueDate: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params): Promise<AgentToolResult<Task>> {
        const title = normalizeText(params.title, "Taskboard title", maxTitleLength);
        const description = normalizeDescription(params.description);
        const priority = params.priority ?? "medium";
        const dueDate = normalizeDueDate(params.dueDate);
        const task = await mutate((database) => {
          const rows = database.prepare("SELECT task_key FROM tasks WHERE task_key LIKE ?").all(`${keyPrefix}-%`) as Array<Record<string, unknown>>;
          const nextNumber =
            rows.reduce((max, row) => {
              const match = typeof row.task_key === "string" ? row.task_key.match(new RegExp(`^${keyPrefix}-(\\d+)$`, "u")) : null;
              return match === null ? max : Math.max(max, Number.parseInt(match[1] ?? "0", 10));
            }, 0) + 1;
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
          return next;
        });
        return { content: [{ type: "text", text: `Task created: ${task.key} (${task.id}) [${task.status}] ${task.title}` }], details: task };
      },
    });

    const listTool = defineTool({
      name: "taskboard_list",
      label: "List taskboard tasks",
      description: "List bounded local tasks for this workspace, optionally filtered by status or text.",
      promptSnippet: "list taskboard tasks for this workspace",
      parameters: Type.Object({
        status: Type.Optional(
          Type.Union(statuses.map((status) => Type.Literal(status)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
        ),
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_toolCallId, params): Promise<AgentToolResult<TaskReport>> {
        const query = params.query === undefined ? undefined : normalizeText(params.query, "Taskboard query", maxQueryLength);
        const limit = Math.max(1, Math.min(maxTasksPerList, Math.trunc(params.limit ?? 20)));
        const report = await withDatabase((database) => {
          const rows = database.prepare("SELECT * FROM tasks WHERE workspace = ? ORDER BY updated_at DESC, task_key DESC").all(workspace) as Array<
            Record<string, unknown>
          >;
          const all = rows.map(taskFromRow).filter((task) => {
            if (params.status !== undefined && task.status !== params.status) return false;
            if (query === undefined) return true;
            const needle = query.toLocaleLowerCase();
            return `${task.key} ${task.title} ${task.description}`.toLocaleLowerCase().includes(needle);
          });
          return {
            ...(params.status === undefined ? {} : { status: params.status as TaskStatus }),
            ...(query === undefined ? {} : { query }),
            total: all.length,
            tasks: all.slice(0, limit),
          } satisfies TaskReport;
        });
        return {
          content: [
            {
              type: "text",
              text:
                report.total === 0
                  ? "No taskboard tasks found."
                  : report.tasks.map((task) => `${task.key} [${task.status}/${task.priority}] ${task.title}`).join("\n"),
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
      parameters: Type.Object({
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
        clearDueDate: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, params): Promise<AgentToolResult<Task>> {
        const key = normalizeText(params.key, "Taskboard key", 32).toUpperCase();
        if (params.status === "done") throw new Error("Taskboard tasks must reach in_review before taskboard_accept can mark them done");
        if (
          params.title === undefined &&
          params.description === undefined &&
          params.status === undefined &&
          params.priority === undefined &&
          params.dueDate === undefined &&
          params.clearDueDate !== true
        )
          throw new Error("Taskboard update requires at least one changed field");
        if (params.dueDate !== undefined && params.clearDueDate === true) throw new Error("Taskboard dueDate and clearDueDate cannot be used together");
        const title = params.title === undefined ? undefined : normalizeText(params.title, "Taskboard title", maxTitleLength);
        const description = params.description === undefined ? undefined : normalizeDescription(params.description);
        const dueDate = normalizeDueDate(params.dueDate);
        const task = await mutate((database) => {
          const current = findTask(database, key);
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
          };
          if (params.clearDueDate === true) delete next.dueDate;
          database
            .prepare(
              "UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, due_date = ?, updated_at = ?, version = ? WHERE workspace = ? AND task_key = ? AND version = ?",
            )
            .run(next.title, next.description, next.status, next.priority, next.dueDate ?? null, next.updatedAt, next.version, workspace, key, current.version);
          return next;
        });
        return { content: [{ type: "text", text: `Task updated: ${task.key} [${task.status}] ${task.title}` }], details: task };
      },
    });

    const acceptTool = defineTool({
      name: "taskboard_accept",
      label: "Accept taskboard task",
      description: "Accept a task in review as done after explicit confirmation.",
      promptSnippet: "accept a reviewed taskboard task as done",
      parameters: Type.Object({ key: Type.String(), confirm: Type.Boolean() }),
      async execute(_toolCallId, params): Promise<AgentToolResult<Task>> {
        const key = normalizeText(params.key, "Taskboard key", 32).toUpperCase();
        if (params.confirm !== true) throw new Error("Accepting a task requires confirm=true");
        const task = await mutate((database) => {
          const current = findTask(database, key);
          if (current === undefined) throw new Error(`Taskboard task not found: ${key}`);
          if (current.status !== "in_review") throw new Error(`Taskboard task ${key} must be in_review before acceptance`);
          const next = { ...current, status: "done" as const, updatedAt: new Date().toISOString(), version: current.version + 1 };
          database
            .prepare("UPDATE tasks SET status = ?, updated_at = ?, version = ? WHERE workspace = ? AND task_key = ? AND version = ?")
            .run("done", next.updatedAt, next.version, workspace, key, current.version);
          return next;
        });
        return { content: [{ type: "text", text: `Task accepted: ${task.key} [done] ${task.title}` }], details: task };
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
          pluginId: "@pi-harness/core/plugins/taskboard",
          title: "Taskboard",
          description: "本工作区的本地任务、状态流转与验收队列。",
          icon: "▦",
          read: async (): Promise<TaskboardPanel> => {
            const report = await withDatabase((database) => {
              const rows = database.prepare("SELECT * FROM tasks WHERE workspace = ? ORDER BY updated_at DESC, task_key DESC").all(workspace) as Array<
                Record<string, unknown>
              >;
              const tasks = rows.map(taskFromRow);
              const counts = Object.fromEntries(statuses.map((status) => [status, tasks.filter((task) => task.status === status).length])) as Record<
                TaskStatus,
                number
              >;
              return { workspace, total: tasks.length, counts, recent: tasks.slice(0, 8) };
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
