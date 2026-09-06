import type { Context } from "@deepseek-ai/cordis";
import { EmptyConfig } from "../config.js";

const maxFailures = 50;
const maxMessageLength = 2_048;
const maxPathLength = 512;
const maxPreviewStringLength = 512;
const maxPreviewProperties = 12;
const maxPreviewDepth = 3;
const maxPreviewNodes = 64;
const maxAgentMessagesScanned = 10_000;

type Failure = { time: string; source: string; message: string; occurrences: number };
type PreviewState = { remaining: number; readonly seen: WeakSet<object> };

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value.replaceAll("\0", "�");
  return value.slice(0, limit - 1).replaceAll("\0", "�") + "…";
}

function incrementCount(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function preview(value: unknown, state: PreviewState, depth = 0): unknown {
  if (state.remaining <= 0) return "[Truncated]";
  state.remaining -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value, maxPreviewStringLength);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[Undefined]";
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return String(value);
  if (typeof value !== "object") return "[Unknown]";
  if (depth >= maxPreviewDepth) return "[Max Depth]";
  if (state.seen.has(value)) return "[Circular]";
  state.seen.add(value);

  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const rawLength: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : 0;
      const arrayLength = typeof rawLength === "number" && Number.isSafeInteger(rawLength) && rawLength >= 0 ? rawLength : 0;
      const length = Math.min(arrayLength, maxPreviewProperties);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        output.push(descriptor === undefined ? null : "value" in descriptor ? preview(descriptor.value as unknown, state, depth + 1) : "[Accessor]");
      }
      if (arrayLength > maxPreviewProperties) output.push(`[${arrayLength - maxPreviewProperties} more items]`);
      return output;
    }
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of ["name", "message", "code", "reason", "detail", "cause", "attempt"]) {
      const property = dataProperty(value, key);
      if (!property.present) continue;
      entries.push([key, property.accessor ? "[Accessor]" : preview(property.value, state, depth + 1)]);
    }
    return entries.length === 0 ? "[Object failure]" : Object.fromEntries(entries);
  } catch {
    return "[Unavailable]";
  }
}

function previewText(value: unknown): string {
  if (typeof value === "string") return boundedText(value, maxMessageLength);
  if (typeof value === "object" && value !== null) {
    const message = dataProperty(value, "message");
    if (!message.accessor && typeof message.value === "string" && message.value.trim() !== "") return boundedText(message.value, maxMessageLength);
  }
  const sanitized = preview(value, { remaining: maxPreviewNodes, seen: new WeakSet<object>() });
  try {
    return boundedText(typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized), maxMessageLength);
  } catch {
    return "[Unavailable failure]";
  }
}

function dataProperty(value: object, key: string): { present: boolean; value?: unknown; accessor: boolean } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { present: false, accessor: false };
    if (!("value" in descriptor)) return { present: true, accessor: true };
    return { present: true, value: descriptor.value as unknown, accessor: false };
  } catch {
    return { present: true, accessor: true };
  }
}

function findAgentFailure(event: object): unknown {
  const messagesProperty = dataProperty(event, "messages");
  if (messagesProperty.accessor || typeof messagesProperty.value !== "object" || messagesProperty.value === null) return undefined;
  const lengthProperty = dataProperty(messagesProperty.value, "length");
  const length = lengthProperty.accessor ? undefined : lengthProperty.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0) return undefined;
  const firstIndex = Math.max(0, length - maxAgentMessagesScanned);
  for (let index = length - 1; index >= firstIndex; index -= 1) {
    const messageProperty = dataProperty(messagesProperty.value, String(index));
    if (messageProperty.accessor || typeof messageProperty.value !== "object" || messageProperty.value === null) continue;
    const role = dataProperty(messageProperty.value, "role");
    const stopReason = dataProperty(messageProperty.value, "stopReason");
    if (role.accessor || stopReason.accessor || role.value !== "assistant" || stopReason.value !== "error") continue;
    const errorMessage = dataProperty(messageProperty.value, "errorMessage");
    if (errorMessage.accessor || errorMessage.value === undefined || (typeof errorMessage.value === "string" && errorMessage.value.trim() === ""))
      return "Agent turn failed";
    return errorMessage.value;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null) {
      const nested = dataProperty(error, "error");
      if (nested.present) {
        const message = nested.accessor ? "[Accessor]" : previewText(nested.value);
        const path = dataProperty(error, "extensionPath");
        const pathText = !path.accessor && typeof path.value === "string" ? boundedText(path.value, maxPathLength) : "";
        return boundedText(pathText === "" ? message : `${pathText}: ${message}`, maxMessageLength);
      }
    }
    return boundedText(previewText(error), maxMessageLength);
  } catch {
    return "[Unavailable failure]";
  }
}

function cloneFailure(failure: Failure): Failure {
  return { ...failure };
}

export default {
  name: "pi-fail-logger",
  inject: ["piPluginUi"],
  Config: EmptyConfig,
  apply(context: Context) {
    const failures: Failure[] = [];
    const indexed = new Map<string, Failure>();
    let observed = 0;
    let dropped = 0;
    const record = (source: string, error: unknown): void => {
      observed = incrementCount(observed);
      const message = messageOf(error);
      const fingerprint = `${source}:${message}`;
      const existing = indexed.get(fingerprint);
      const time = new Date().toISOString();
      if (existing !== undefined) {
        existing.time = time;
        existing.occurrences = incrementCount(existing.occurrences);
        const index = failures.indexOf(existing);
        if (index >= 0) failures.splice(index, 1);
        failures.push(existing);
        return;
      }
      const failure = { time, source, message, occurrences: 1 };
      indexed.set(fingerprint, failure);
      failures.push(failure);
      if (failures.length > maxFailures) {
        const removed = failures.shift();
        if (removed !== undefined) indexed.delete(`${removed.source}:${removed.message}`);
        dropped = incrementCount(dropped);
      }
    };
    const unsubscribeExtension = context.on("pi/extension-error", (error) => record("extension", error));
    const unsubscribeSession = context.on("pi/session-event", (event) => {
      const eventType = dataProperty(event, "type").value;
      if (eventType === "agent_end") {
        const error = findAgentFailure(event);
        if (error !== undefined) record("agent", error);
      }
      if (eventType === "compaction_end") {
        const aborted = dataProperty(event, "aborted");
        const errorMessage = dataProperty(event, "errorMessage");
        if ((!aborted.accessor && aborted.value === true) || errorMessage.accessor || !errorMessage.value) return;
        record("compaction", errorMessage.value);
      }
    });
    const disposePanel = context.piPluginUi.register({
      id: "fail-logger-panel",
      pluginId: "@pi-harness/core/plugins/fail-logger",
      title: "Failure Logger",
      description: "集中聚合扩展、Agent 和上下文压缩错误，并安全截断诊断内容。",
      icon: "!",
      read: () => ({
        total: failures.length,
        observed,
        dropped,
        capacity: maxFailures,
        failures: failures
          .slice()
          .reverse()
          .map((failure) => cloneFailure(failure)),
      }),
    });
    context.effect(() => () => {
      unsubscribeExtension();
      unsubscribeSession();
      disposePanel();
    });
  },
};
