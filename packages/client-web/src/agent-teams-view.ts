export type AgentTeamTaskStatus = "todo" | "blocked" | "in_progress" | "done";
export type AgentTeamMemberStatus = "idle" | "working";

export interface AgentTeamMemberView {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly status: AgentTeamMemberStatus;
}

export interface AgentTeamTaskView {
  readonly id: string;
  readonly title: string;
  readonly assignee: string;
  readonly status: AgentTeamTaskStatus;
  readonly dependsOn: readonly string[];
}

export interface AgentTeamMessageView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly timestamp: string;
  readonly read: boolean;
}

const limits = {
  members: 64,
  tasks: 256,
  messages: 1_000,
  messageCharacters: 4_000,
  mailboxReadMessages: 25,
  agentTextBytes: 32 * 1024,
  stateBytes: 8 * 1024 * 1024,
  stateScanEntries: 10_000,
  panelMembers: 12,
  panelTasks: 20,
  panelMessages: 5,
} as const;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const taskStatuses = new Set<AgentTeamTaskStatus>(["todo", "blocked", "in_progress", "done"]);
const memberStatuses = new Set<AgentTeamMemberStatus>(["idle", "working"]);
const maxNameCharacters = 200;
const maxRoleCharacters = 200;
const maxTitleCharacters = 200;
const maxDisplayedDependencies = 20;
const maxDisplayedReadyTasks = 20;
const maxDisplayedCycleIds = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown, maximum: number, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fallback;
}

function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.replaceAll(/\p{Cc}/gu, "�").slice(0, maximum) : "";
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && idPattern.test(value) ? value : undefined;
}

function member(value: unknown): AgentTeamMemberView | undefined {
  if (!isRecord(value)) return undefined;
  const memberId = id(value.id);
  const name = text(value.name, maxNameCharacters);
  if (memberId === undefined || name === "") return undefined;
  const role = text(value.role, maxRoleCharacters) || "协作成员";
  const status =
    typeof value.status === "string" && memberStatuses.has(value.status as AgentTeamMemberStatus) ? (value.status as AgentTeamMemberStatus) : "idle";
  return { id: memberId, name, role, status };
}

function task(value: unknown): AgentTeamTaskView | undefined {
  if (!isRecord(value)) return undefined;
  const taskId = id(value.id);
  const title = text(value.title, maxTitleCharacters);
  const assignee = value.assignee === "unassigned" ? "unassigned" : id(value.assignee);
  if (taskId === undefined || title === "" || assignee === undefined) return undefined;
  const status = typeof value.status === "string" && taskStatuses.has(value.status as AgentTeamTaskStatus) ? (value.status as AgentTeamTaskStatus) : "todo";
  const rawDependencies = Array.isArray(value.dependsOn) ? value.dependsOn.slice(0, maxDisplayedDependencies) : [];
  const dependsOn = rawDependencies.map(id).filter((candidate): candidate is string => candidate !== undefined);
  return { id: taskId, title, assignee, status, dependsOn };
}

function message(value: unknown): AgentTeamMessageView | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = id(value.id);
  const from = id(value.from);
  const to = id(value.to);
  const body = text(value.body, limits.messageCharacters);
  if (messageId === undefined || from === undefined || to === undefined || body === "" || typeof value.timestamp !== "string") return undefined;
  let timestamp: string;
  try {
    timestamp = new Date(value.timestamp).toISOString();
  } catch {
    return undefined;
  }
  if (timestamp !== value.timestamp) return undefined;
  return { id: messageId, from, to, body, timestamp, read: value.read === true };
}

function ids(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maximum)
    .map(id)
    .filter((candidate): candidate is string => candidate !== undefined);
}

function taskDependencyDataWasTruncated(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.dependsOn)) return value.dependsOn !== undefined;
  const visible = value.dependsOn.slice(0, maxDisplayedDependencies);
  return value.dependsOn.length > visible.length || visible.some((candidate) => id(candidate) === undefined);
}

function inventory(source: unknown, shown: number, maximum: number, truncated: boolean): { total: number; shown: number; truncated: boolean } {
  const value = isRecord(source) ? source : {};
  const total = Math.max(shown, count(value.total, maximum, shown));
  return { total, shown, truncated: value.truncated === true || truncated || total > shown };
}

export function agentTeamsPanelView(data: unknown) {
  const source = isRecord(data) ? data : {};
  const rawMembers = Array.isArray(source.members) ? source.members : [];
  const rawTasks = Array.isArray(source.tasks) ? source.tasks : [];
  const rawMessages = Array.isArray(source.messages) ? source.messages : [];
  const visibleMembers = rawMembers.slice(0, limits.panelMembers);
  const visibleTasks = rawTasks.slice(0, limits.panelTasks);
  const visibleMessages = rawMessages.slice(0, limits.panelMessages);
  const members = visibleMembers.map(member).filter((candidate): candidate is AgentTeamMemberView => candidate !== undefined);
  const tasks = visibleTasks.map(task).filter((candidate): candidate is AgentTeamTaskView => candidate !== undefined);
  const messages = visibleMessages.map(message).filter((candidate): candidate is AgentTeamMessageView => candidate !== undefined);
  const readyTasks = ids(source.readyTasks, maxDisplayedReadyTasks);
  const dependencyCycle = Array.isArray(source.dependencyCycle) ? ids(source.dependencyCycle, maxDisplayedCycleIds) : null;
  const membersTruncated =
    (source.members !== undefined && !Array.isArray(source.members)) || rawMembers.length > visibleMembers.length || members.length !== visibleMembers.length;
  const tasksTruncated =
    (source.tasks !== undefined && !Array.isArray(source.tasks)) ||
    rawTasks.length > visibleTasks.length ||
    tasks.length !== visibleTasks.length ||
    visibleTasks.some(taskDependencyDataWasTruncated) ||
    (source.readyTasks !== undefined && !Array.isArray(source.readyTasks)) ||
    (Array.isArray(source.readyTasks) && source.readyTasks.length > readyTasks.length) ||
    (source.dependencyCycle !== undefined && source.dependencyCycle !== null && !Array.isArray(source.dependencyCycle)) ||
    (Array.isArray(source.dependencyCycle) && source.dependencyCycle.length > (dependencyCycle?.length ?? 0));
  const messagesTruncated =
    (source.messages !== undefined && !Array.isArray(source.messages)) ||
    rawMessages.length > visibleMessages.length ||
    messages.length !== visibleMessages.length;
  const browserTruncated = membersTruncated || tasksTruncated || messagesTruncated;
  const rawInventory = isRecord(source.inventory) ? source.inventory : {};
  const membersInventory = inventory(rawInventory.members, members.length, limits.members, membersTruncated);
  const tasksInventory = inventory(rawInventory.tasks, tasks.length, limits.tasks, tasksTruncated);
  const rawTaskInventory = isRecord(rawInventory.tasks) ? rawInventory.tasks : {};
  const ready = Math.max(readyTasks.length, count(rawTaskInventory.ready, tasksInventory.total, readyTasks.length));
  const rawMessageInventory = isRecord(rawInventory.messages) ? rawInventory.messages : {};
  const messagesInventory = inventory(rawMessageInventory, messages.length, limits.messages, messagesTruncated);
  const computedUnread = messages.filter((item) => !item.read).length;
  const unread = count(rawMessageInventory.unread, messagesInventory.total, computedUnread);
  const rawHistory = isRecord(source.history) ? source.history : {};
  const available = count(rawHistory.available, Number.MAX_SAFE_INTEGER);
  const scanned = count(rawHistory.scanned, available);
  return {
    members,
    tasks,
    messages,
    readyTasks,
    dependencyCycle,
    inventory: {
      members: membersInventory,
      tasks: { ...tasksInventory, ready },
      messages: { ...messagesInventory, unread },
    },
    history: {
      available,
      scanned,
      truncated: rawHistory.truncated === true,
      restored: rawHistory.restored === true,
    },
    limits,
    truncated: browserTruncated,
  };
}
