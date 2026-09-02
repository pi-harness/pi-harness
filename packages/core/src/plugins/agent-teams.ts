import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const customType = "pi-harness/agent-teams";
type TeamState = {
  members: { id: string; name: string; role: string; status: string }[];
  tasks: { id: string; title: string; assignee: string; status: string }[];
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
  return structuredClone({ members: value.members, tasks: value.tasks });
}

function persist(context: Context, state: TeamState): void {
  context.piSession.manager.appendCustomEntry(customType, state);
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
          action: Type.String({ description: "add_task, update_task, or add_member" }),
          id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          assignee: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          role: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
        }),
        execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
          return Promise.resolve().then(() => {
            const state = readState(context);
            if (params.action === "add_task") {
              const title = params.title?.trim();
              if (!title) throw new Error("title is required when action is add_task");
              const task = {
                id: params.id?.trim() || `task-${state.tasks.length + 1}`,
                title,
                assignee: params.assignee?.trim() || "unassigned",
                status: params.status?.trim() || "todo",
              };
              state.tasks.push(task);
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Task ${task.id} created.` }], details: { kind: "task", item: task } };
            }
            if (params.action === "update_task") {
              const task = state.tasks.find((item) => item.id === params.id);
              if (!task) throw new Error(`Task not found: ${params.id ?? ""}`);
              if (params.title?.trim()) task.title = params.title.trim();
              if (params.assignee?.trim()) task.assignee = params.assignee.trim();
              if (params.status?.trim()) task.status = params.status.trim();
              persist(context, state);
              return { content: [{ type: "text" as const, text: `Task ${task.id} updated.` }], details: { kind: "task", item: task } };
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
