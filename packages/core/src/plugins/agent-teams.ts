import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const customType = "pi-harness/agent-teams";
type TeamTask = { id: string; title: string; assignee: string; status: string; dependsOn: string[] };
type TeamState = {
  members: { id: string; name: string; role: string; status: string }[];
  tasks: TeamTask[];
};

const initialState = (): TeamState => ({
  members: [
    { id: "planner", name: "Planner", role: "拆解任务", status: "idle" },
    { id: "builder", name: "Builder", role: "实现改动", status: "idle" },
    { id: "reviewer", name: "Reviewer", role: "验证结果", status: "idle" },
  ],
  tasks: [],
});

function readState(context: Context): TeamState {
  const entries = context.piSession.manager.getEntries();
  const entry = [...entries].reverse().find((item) => item.type === "custom" && item.customType === customType);
  if (entry?.type !== "custom" || entry.data === undefined) return initialState();
  const value = entry.data as Partial<TeamState>;
  if (!Array.isArray(value.members) || !Array.isArray(value.tasks)) return initialState();
  const tasks = value.tasks.map((task, index) => {
    const item = task as Partial<TeamTask>;
    return {
      id: typeof item.id === "string" && item.id.trim() !== "" ? item.id : `task-${index + 1}`,
      title: typeof item.title === "string" ? item.title : "未命名任务",
      assignee: typeof item.assignee === "string" ? item.assignee : "unassigned",
      status: typeof item.status === "string" ? item.status : "todo",
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((id): id is string => typeof id === "string" && id.trim() !== "") : [],
    };
  });
  return structuredClone({ members: value.members, tasks });
}

function persist(context: Context, state: TeamState): void {
  context.piSession.manager.appendCustomEntry(customType, state);
}

function refreshTaskReadiness(state: TeamState): void {
  const completed = new Set(state.tasks.filter((task) => task.status === "done").map((task) => task.id));
  for (const task of state.tasks) {
    if (task.status === "blocked" && task.dependsOn.every((id) => completed.has(id))) task.status = "todo";
    if ((task.status === "todo" || task.status === "blocked") && task.dependsOn.some((id) => !completed.has(id))) task.status = "blocked";
  }
}

function nextReadyTask(state: TeamState, assignee: string): TeamTask {
  refreshTaskReadiness(state);
  const task = state.tasks.find((item) => item.status === "todo");
  if (task === undefined) throw new Error("No ready team task is available");
  task.status = "in_progress";
  task.assignee = assignee || task.assignee;
  return task;
}

export default {
  name: "pi-agent-teams",
  inject: ["piSession", "piTools", "piPluginUi"],
  apply(context: Context) {
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "team_task",
        label: "Team task",
        description: "Create or update a durable agent-team member or task in the current Pi session.",
        promptSnippet: "manage durable team members and tasks",
        parameters: Type.Object({
          action: Type.String({ description: "add_task, update_task, claim_task, or add_member" }),
          id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          assignee: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          role: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          dependsOn: Type.Optional(Type.Array(Type.String())),
        }),
        execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
          return Promise.resolve().then(() => {
            const state = readState(context);
            if (params.action === "add_task") {
              const title = params.title?.trim();
              if (!title) throw new Error("title is required when action is add_task");
              const id = params.id?.trim() || `task-${state.tasks.length + 1}`;
              if (state.tasks.some((item) => item.id === id)) throw new Error(`Task already exists: ${id}`);
              const dependsOn = [...new Set((params.dependsOn ?? []).map((item) => item.trim()).filter(Boolean))];
              if (dependsOn.includes(id)) throw new Error("A task cannot depend on itself");
              if (dependsOn.some((dependency) => !state.tasks.some((item) => item.id === dependency)))
                throw new Error("All task dependencies must already exist");
              const task = {
                id,
                title,
                assignee: params.assignee?.trim() || "unassigned",
                status: params.status?.trim() || "todo",
                dependsOn,
              };
              state.tasks.push(task);
              refreshTaskReadiness(state);
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Task ${task.id} created.` }], details: { kind: "task", item: task } };
            }
            if (params.action === "update_task") {
              const task = state.tasks.find((item) => item.id === params.id);
              if (!task) throw new Error(`Task not found: ${params.id ?? ""}`);
              if (params.title?.trim()) task.title = params.title.trim();
              if (params.assignee?.trim()) task.assignee = params.assignee.trim();
              if (params.status?.trim()) {
                if (
                  params.status.trim() === "done" &&
                  task.dependsOn.some((dependency) => state.tasks.find((item) => item.id === dependency)?.status !== "done")
                )
                  throw new Error("A task cannot be completed before its dependencies");
                task.status = params.status.trim();
              }
              refreshTaskReadiness(state);
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Task ${task.id} updated.` }], details: { kind: "task", item: task } };
            }
            if (params.action === "claim_task") {
              const task = nextReadyTask(state, params.assignee?.trim() || "unassigned");
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Task ${task.id} claimed.` }], details: { kind: "task", item: task } };
            }
            if (params.action === "add_member") {
              const name = params.name?.trim();
              if (!name) throw new Error("name is required when action is add_member");
              const member = {
                id: params.id?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                name,
                role: params.role?.trim() || "协作成员",
                status: params.status?.trim() || "idle",
              };
              state.members.push(member);
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Member ${member.name} added.` }], details: { kind: "member", item: member } };
            }
            throw new Error(`Unknown team action: ${params.action}`);
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "agent-teams-panel",
      pluginId: "@pi-harness/core/plugins/agent-teams",
      title: "Agent Teams",
      description: "查看协作成员、任务状态和当前会话中的持久化任务队列。",
      icon: "◎",
      read: () => readState(context),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
