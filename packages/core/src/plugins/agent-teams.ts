import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const customType = "pi-harness/agent-teams";
export type TeamTask = { id: string; title: string; assignee: string; status: string; dependsOn: string[] };
type TeamMessage = { id: string; from: string; to: string; body: string; timestamp: string; read: boolean };
type TeamState = {
  members: { id: string; name: string; role: string; status: string }[];
  tasks: TeamTask[];
  messages: TeamMessage[];
};

export function dependencyCycle(tasks: readonly TeamTask[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return start >= 0 ? [...path.slice(start), id] : [id, id];
    }
    if (visited.has(id)) return null;
    const task = byId.get(id);
    if (task === undefined) {
      visited.add(id);
      return null;
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of task.dependsOn) {
      const cycle = visit(dependency);
      if (cycle !== null) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle !== null) return cycle;
  }
  return null;
}

export function readyTeamTasks(tasks: readonly TeamTask[]): TeamTask[] {
  const completed = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  return tasks.filter((task) => task.status === "todo" && task.dependsOn.every((dependency) => completed.has(dependency)));
}

const initialState = (): TeamState => ({
  members: [
    { id: "planner", name: "Planner", role: "拆解任务", status: "idle" },
    { id: "builder", name: "Builder", role: "实现改动", status: "idle" },
    { id: "reviewer", name: "Reviewer", role: "验证结果", status: "idle" },
  ],
  tasks: [],
  messages: [],
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
  const messages = Array.isArray(value.messages)
    ? value.messages.flatMap((message, index) => {
        const item = message as Partial<TeamMessage>;
        if (typeof item.from !== "string" || typeof item.to !== "string" || typeof item.body !== "string") return [];
        return [
          {
            id: typeof item.id === "string" && item.id.trim() !== "" ? item.id : `message-${index + 1}`,
            from: item.from,
            to: item.to,
            body: item.body,
            timestamp: typeof item.timestamp === "string" ? item.timestamp : new Date(0).toISOString(),
            read: item.read === true,
          },
        ];
      })
    : [];
  return structuredClone({ members: value.members, tasks, messages });
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

function syncMemberStatuses(state: TeamState): void {
  const activeAssignees = new Set(state.tasks.filter((task) => task.status === "in_progress").map((task) => task.assignee));
  for (const member of state.members) {
    if (member.status === "working" || activeAssignees.has(member.id)) member.status = activeAssignees.has(member.id) ? "working" : "idle";
  }
}

function nextReadyTask(state: TeamState, assignee: string): TeamTask {
  refreshTaskReadiness(state);
  const task = readyTeamTasks(state.tasks)[0];
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
        description: "Create or update durable agent-team members, tasks, and mailbox messages in the current Pi session.",
        promptSnippet: "manage durable team members, tasks, and mailbox messages",
        parameters: Type.Object({
          action: Type.String({ description: "add_task, update_task, claim_task, add_member, send_message, or read_messages" }),
          id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          assignee: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          role: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          dependsOn: Type.Optional(Type.Array(Type.String())),
          from: Type.Optional(Type.String()),
          to: Type.Optional(Type.String()),
          body: Type.Optional(Type.String()),
          unreadOnly: Type.Optional(Type.Boolean()),
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
              const cycle = dependencyCycle(state.tasks);
              if (cycle !== null) {
                state.tasks.pop();
                throw new Error(`Task dependency cycle detected: ${cycle.join(" → ")}`);
              }
              refreshTaskReadiness(state);
              syncMemberStatuses(state);
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Task ${task.id} created.` }], details: { kind: "task", item: task } };
            }
            if (params.action === "update_task") {
              const task = state.tasks.find((item) => item.id === params.id);
              if (!task) throw new Error(`Task not found: ${params.id ?? ""}`);
              if (params.title?.trim()) task.title = params.title.trim();
              if (params.assignee?.trim()) task.assignee = params.assignee.trim();
              if (params.dependsOn !== undefined) {
                const dependsOn = [...new Set(params.dependsOn.map((item) => item.trim()).filter(Boolean))];
                if (dependsOn.includes(task.id)) throw new Error("A task cannot depend on itself");
                if (dependsOn.some((dependency) => !state.tasks.some((item) => item.id === dependency)))
                  throw new Error("All task dependencies must already exist");
                const previous = task.dependsOn;
                task.dependsOn = dependsOn;
                const cycle = dependencyCycle(state.tasks);
                if (cycle !== null) {
                  task.dependsOn = previous;
                  throw new Error(`Task dependency cycle detected: ${cycle.join(" → ")}`);
                }
              }
              if (params.status?.trim()) {
                if (
                  params.status.trim() === "done" &&
                  task.dependsOn.some((dependency) => state.tasks.find((item) => item.id === dependency)?.status !== "done")
                )
                  throw new Error("A task cannot be completed before its dependencies");
                task.status = params.status.trim();
              }
              refreshTaskReadiness(state);
              syncMemberStatuses(state);
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Task ${task.id} updated.` }], details: { kind: "task", item: task } };
            }
            if (params.action === "claim_task") {
              const task = nextReadyTask(state, params.assignee?.trim() || "unassigned");
              const member = state.members.find((item) => item.id === task.assignee);
              if (member !== undefined) member.status = "working";
              syncMemberStatuses(state);
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
              if (state.members.some((item) => item.id === member.id)) throw new Error(`Member already exists: ${member.id}`);
              state.members.push(member);
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Member ${member.name} added.` }], details: { kind: "member", item: member } };
            }
            if (params.action === "send_message") {
              const from = params.from?.trim();
              const to = params.to?.trim();
              const body = params.body?.trim();
              if (!from || !to || !body) throw new Error("from, to, and body are required when action is send_message");
              if (!state.members.some((item) => item.id === from)) throw new Error(`Unknown sender: ${from}`);
              if (!state.members.some((item) => item.id === to)) throw new Error(`Unknown recipient: ${to}`);
              if (body.length > 4000) throw new Error("Message body must be 4000 characters or fewer");
              const message: TeamMessage = {
                id: `message-${state.messages.length + 1}`,
                from,
                to,
                body,
                timestamp: new Date().toISOString(),
                read: false,
              };
              state.messages.push(message);
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Message ${message.id} sent.` }], details: { kind: "message", item: message } };
            }
            if (params.action === "read_messages") {
              const to = params.to?.trim();
              if (!to) throw new Error("to is required when action is read_messages");
              if (!state.members.some((item) => item.id === to)) throw new Error(`Unknown recipient: ${to}`);
              const messages = state.messages.filter((message) => message.to === to && (!params.unreadOnly || !message.read));
              for (const message of messages) message.read = true;
              if (messages.length > 0) persist(context, state);
              return {
                content: [{ type: "text" as const, text: `${messages.length} message${messages.length === 1 ? "" : "s"} read.` }],
                details: { kind: "mailbox", messages },
              };
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
      read: () => {
        const state = readState(context);
        const cycle = dependencyCycle(state.tasks);
        return {
          ...state,
          readyTasks: readyTeamTasks(state.tasks).map((task) => task.id),
          dependencyCycle: cycle,
        };
      },
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
