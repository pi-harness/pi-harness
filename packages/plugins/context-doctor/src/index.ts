import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { tryAcquireSessionCompaction } from "@pi-harness/plugin-api";

type ContextDoctorReport = {
  status: "ok" | "warning";
  usagePercent: number | null;
  tokens: number | null;
  contextWindow: number | null;
  messageCount: number;
  scannedMessages: number;
  messagesTruncated: boolean;
  oversizedMessages: number;
  uninspectableMessages: number;
  toolErrors: number;
  warnPercent: number;
  maxMessageBytes: number;
  recommendations: string[];
};

type ContextCompactionState = {
  status: "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

type ContextDoctorToolDetails = ContextDoctorReport & {
  compacted: boolean;
  compaction: ContextCompactionState;
};

const defaultWarnPercent = 75;
const defaultMaxMessageBytes = 64 * 1024;
const maxScannedMessages = 10_000;
const maxJsonDepth = 64;
const maxJsonNodes = 10_000;
const maxJsonNodesPerAudit = 100_000;
const toolParameterNames = new Set(["compact", "confirm"]);
const maxErrorLength = 2_000;

export interface ContextDoctorPluginConfig {
  warnPercent?: number;
  maxMessageBytes?: number;
}

export const Config: z<ContextDoctorPluginConfig> = z.object({
  warnPercent: z.number().min(1).max(100).default(defaultWarnPercent),
  maxMessageBytes: z
    .number()
    .min(1024)
    .max(1024 * 1024)
    .step(1)
    .default(defaultMaxMessageBytes),
});

type JsonMeasurement = { bytes: number; inspectable: boolean; omitted: boolean };

function measureJsonBytes(value: unknown, maximum: number, auditBudget: { remaining: number }): JsonMeasurement {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const uninspectable = (): JsonMeasurement => ({ bytes: maximum + 1, inspectable: false, omitted: false });
  const measure = (current: unknown, depth: number, arrayItem: boolean): JsonMeasurement => {
    nodes += 1;
    auditBudget.remaining -= 1;
    if (nodes > maxJsonNodes || auditBudget.remaining < 0 || depth > maxJsonDepth) return uninspectable();
    if (current === null) return { bytes: 4, inspectable: true, omitted: false };
    if (typeof current === "string") return { bytes: Buffer.byteLength(JSON.stringify(current), "utf8"), inspectable: true, omitted: false };
    if (typeof current === "boolean") return { bytes: current ? 4 : 5, inspectable: true, omitted: false };
    if (typeof current === "number") return { bytes: Buffer.byteLength(JSON.stringify(current), "utf8"), inspectable: true, omitted: false };
    if (current === undefined || typeof current === "function" || typeof current === "symbol")
      return arrayItem ? { bytes: 4, inspectable: true, omitted: false } : { bytes: 0, inspectable: true, omitted: true };
    if (typeof current === "bigint") return uninspectable();
    if (ancestors.has(current)) return uninspectable();

    let prototype: unknown;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(current) as unknown;
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      return uninspectable();
    }
    const isArray = Array.isArray(current);
    if (isArray ? prototype !== Array.prototype && prototype !== null : prototype !== Object.prototype && prototype !== null) return uninspectable();
    const toJson = descriptors.toJSON;
    if (toJson !== undefined && (!("value" in toJson) || typeof toJson.value === "function")) return uninspectable();
    if (prototype === Array.prototype || prototype === Object.prototype) {
      const inheritedToJson = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      if (inheritedToJson !== undefined && (!("value" in inheritedToJson) || typeof inheritedToJson.value === "function")) return uninspectable();
    }

    ancestors.add(current);
    let bytes = 2;
    let emitted = 0;
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        ancestors.delete(current);
        return uninspectable();
      }
      const length = lengthDescriptor.value as number;
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor !== undefined && !("value" in descriptor)) {
          ancestors.delete(current);
          return uninspectable();
        }
        const child = measure(descriptor === undefined ? undefined : descriptor.value, depth + 1, true);
        if (!child.inspectable) {
          ancestors.delete(current);
          return child;
        }
        bytes += child.bytes + (index === 0 ? 0 : 1);
        if (bytes > maximum) break;
      }
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) {
          ancestors.delete(current);
          return uninspectable();
        }
        const child = measure(descriptor.value, depth + 1, false);
        if (!child.inspectable) {
          ancestors.delete(current);
          return child;
        }
        if (child.omitted) continue;
        bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + child.bytes + (emitted === 0 ? 0 : 1);
        emitted += 1;
        if (bytes > maximum) break;
      }
    }
    ancestors.delete(current);
    return { bytes, inspectable: true, omitted: false };
  };
  try {
    return measure(value, 0, false);
  } catch {
    return uninspectable();
  }
}

function dataProperty(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeWarnPercent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : defaultWarnPercent;
}

function normalizeMaxMessageBytes(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(1, Math.min(1024 * 1024, value)) : defaultMaxMessageBytes;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function cloneReport(report: ContextDoctorReport): ContextDoctorReport {
  return { ...report, recommendations: [...report.recommendations] };
}

function boundedError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxErrorLength);
  if (error !== null && typeof error === "object") {
    const message = dataProperty(error, "message");
    if (typeof message === "string") return message.slice(0, maxErrorLength);
  }
  return "Unknown context compaction error";
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Context Doctor operation was cancelled", { cause: signal.reason });
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Context Doctor operation was cancelled", { cause: signal.reason }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Context Doctor operation was cancelled", { cause: signal.reason }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function parseToolParams(value: unknown): { compact: boolean } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Context Doctor parameters must be an object");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Context Doctor parameters must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !toolParameterNames.has(key)))
    throw new Error("Context Doctor parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Context Doctor parameters must use data properties");
  const compact = descriptors.compact?.value as unknown;
  const confirm = descriptors.confirm?.value as unknown;
  if (compact !== undefined && typeof compact !== "boolean") throw new Error("compact must be a boolean");
  if (confirm !== undefined && typeof confirm !== "boolean") throw new Error("confirm must be a boolean");
  if (compact === true && confirm !== true) throw new Error("Context compaction requires confirm=true");
  return { compact: compact === true };
}

export function inspectMessages(
  messages: readonly unknown[],
  usage: { percent?: number | null; tokens?: number | null; contextWindow?: number | null } | undefined,
  warnPercent: number,
  maxMessageBytes: number,
): ContextDoctorReport {
  const normalizedWarnPercent = normalizeWarnPercent(warnPercent);
  const normalizedMaxMessageBytes = normalizeMaxMessageBytes(maxMessageBytes);
  const rawMessageCount = dataProperty(messages, "length");
  const messageCount = typeof rawMessageCount === "number" && Number.isSafeInteger(rawMessageCount) && rawMessageCount >= 0 ? rawMessageCount : 0;
  const scannedMessages = Math.min(messageCount, maxScannedMessages);
  const start = messageCount - scannedMessages;
  let oversizedMessages = 0;
  let uninspectableMessages = 0;
  let toolErrors = 0;
  const auditBudget = { remaining: maxJsonNodesPerAudit };
  for (let index = start; index < messageCount; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
    if (descriptor !== undefined && !("value" in descriptor)) {
      oversizedMessages += 1;
      uninspectableMessages += 1;
      continue;
    }
    const message = descriptor?.value as unknown;
    const measurement = measureJsonBytes(message, normalizedMaxMessageBytes, auditBudget);
    if (!measurement.inspectable) uninspectableMessages += 1;
    if (!measurement.inspectable || (!measurement.omitted && measurement.bytes > normalizedMaxMessageBytes)) oversizedMessages += 1;
    if (typeof message === "object" && message !== null && dataProperty(message, "role") === "toolResult" && dataProperty(message, "isError") === true)
      toolErrors += 1;
  }
  const usagePercent = validPercent(usage === undefined ? undefined : dataProperty(usage, "percent"));
  const recommendations: string[] = [];
  if (usagePercent !== null && usagePercent >= normalizedWarnPercent) recommendations.push("压缩较早的会话历史，释放上下文空间。");
  const byteLimitExceededMessages = oversizedMessages - uninspectableMessages;
  if (byteLimitExceededMessages > 0) recommendations.push(`检查 ${byteLimitExceededMessages} 条超大消息，优先引用摘要或文件路径。`);
  if (uninspectableMessages > 0) recommendations.push(`检查 ${uninspectableMessages} 条无法安全测量的消息，其结构可能过深、循环或包含访问器。`);
  if (toolErrors > 0) recommendations.push(`处理 ${toolErrors} 个工具错误后再继续长任务。`);
  return {
    status: recommendations.length === 0 ? "ok" : "warning",
    usagePercent,
    tokens: nonNegativeInteger(usage === undefined ? undefined : dataProperty(usage, "tokens")),
    contextWindow: nonNegativeInteger(usage === undefined ? undefined : dataProperty(usage, "contextWindow")),
    messageCount,
    scannedMessages,
    messagesTruncated: messageCount > scannedMessages,
    oversizedMessages,
    uninspectableMessages,
    toolErrors,
    warnPercent: normalizedWarnPercent,
    maxMessageBytes: normalizedMaxMessageBytes,
    recommendations,
  };
}

export default {
  name: "pi-context-doctor",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ContextDoctorPluginConfig = {}) {
    const warnPercent = normalizeWarnPercent(config.warnPercent);
    const maxMessageBytes = Math.max(1024, normalizeMaxMessageBytes(config.maxMessageBytes));
    const lifecycle = new AbortController();
    let compaction: ContextCompactionState = { status: "idle" };
    let active: Promise<void> | undefined;
    let queued:
      | {
          session: unknown;
          signal: AbortSignal;
          requestedAt: string;
          removeAbortListener: () => void;
        }
      | undefined;
    const runtime = () => context.get("piRuntime");
    let cachedSession: unknown;
    let cachedReport = inspectMessages([], undefined, warnPercent, maxMessageBytes);
    const refreshReport = (): ContextDoctorReport => {
      const service = runtime();
      cachedSession = service?.session;
      let usage: ReturnType<NonNullable<typeof service>["session"]["getContextUsage"]>;
      if (service !== undefined) {
        try {
          usage = service.session.getContextUsage();
        } catch {
          usage = undefined;
        }
      }
      cachedReport =
        service === undefined
          ? inspectMessages([], undefined, warnPercent, maxMessageBytes)
          : inspectMessages(service.session.messages, usage, warnPercent, maxMessageBytes);
      return cloneReport(cachedReport);
    };
    const cancelQueuedForSessionChange = (session: unknown): void => {
      if (queued === undefined || queued.session === session) return;
      const request = queued;
      queued = undefined;
      request.removeAbortListener();
      compaction = {
        status: "cancelled",
        requestedAt: request.requestedAt,
        finishedAt: new Date().toISOString(),
        error: "Session changed before the queued context compaction could start",
      };
    };
    const report = (): ContextDoctorReport => {
      const service = runtime();
      cancelQueuedForSessionChange(service?.session);
      if (service?.session !== cachedSession) return refreshReport();
      return cloneReport(cachedReport);
    };
    refreshReport();
    const details = (compacted: boolean): ContextDoctorToolDetails => ({ ...report(), compacted, compaction: { ...compaction } });
    const startCompaction = (session: NonNullable<ReturnType<typeof runtime>>["session"], signal: AbortSignal, requestedAt: string) => {
      const startedAt = new Date().toISOString();
      const releaseCompaction = session.isCompacting ? undefined : tryAcquireSessionCompaction(session);
      if (releaseCompaction === undefined) {
        const error = new Error("A context compaction is already in progress");
        compaction = { status: "failed", requestedAt, startedAt, finishedAt: new Date().toISOString(), error: error.message };
        return Promise.reject(error);
      }
      compaction = { status: "running", requestedAt, startedAt };
      const operation = Promise.resolve()
        .then(async () => {
          throwIfAborted(signal);
          const cancellableSession = session as typeof session & { abortCompaction?: () => void };
          const abort = (): void => {
            try {
              cancellableSession.abortCompaction?.();
            } catch {
              // Caller cancellation remains authoritative while the runtime tears down.
            }
          };
          let unsubscribeCompaction: (() => void) | undefined;
          signal.addEventListener("abort", abort, { once: true });
          try {
            unsubscribeCompaction = session.subscribe((event) => {
              if (event.type === "compaction_start" && signal.aborted) abort();
            });
            await session.compact();
            compaction = { status: "completed", requestedAt, startedAt, finishedAt: new Date().toISOString() };
            refreshReport();
          } catch (error) {
            compaction = {
              status: signal.aborted ? "cancelled" : "failed",
              requestedAt,
              startedAt,
              finishedAt: new Date().toISOString(),
              error: boundedError(error),
            };
            refreshReport();
            throw error;
          } finally {
            signal.removeEventListener("abort", abort);
            unsubscribeCompaction?.();
          }
        })
        .finally(releaseCompaction);
      active = operation;
      void operation.then(
        () => {
          if (active === operation) active = undefined;
        },
        () => {
          if (active === operation) active = undefined;
        },
      );
      return operation;
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      const eventType = dataProperty(event, "type");
      if (typeof eventType !== "string") return;
      cancelQueuedForSessionChange(runtime()?.session);
      if (["message_end", "tool_execution_end", "agent_end", "agent_settled", "compaction_end", "entry_appended"].includes(eventType)) refreshReport();
      if (eventType !== "agent_settled" || queued === undefined) return;
      const request = queued;
      queued = undefined;
      request.removeAbortListener();
      const service = runtime();
      if (service === undefined || service.session !== request.session) {
        compaction = {
          status: "cancelled",
          requestedAt: request.requestedAt,
          finishedAt: new Date().toISOString(),
          error: "Session changed before the queued context compaction could start",
        };
        return;
      }
      void startCompaction(service.session, request.signal, request.requestedAt).catch(() => undefined);
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("Context Doctor plugin disposed"));
      if (queued !== undefined) {
        queued.removeAbortListener();
        queued = undefined;
      }
      unsubscribe();
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "context_doctor",
        label: "Context doctor",
        description:
          "Audit context pressure, oversized or uninspectable messages, and tool errors; confirmed compaction is queued until the active agent has settled.",
        promptSnippet: "audit context pressure and recommend safe cleanup",
        promptGuidelines: ["Set compact=true only with confirm=true after the user approves model-backed compaction that may incur usage and cost."],
        parameters: Type.Object(
          {
            compact: Type.Optional(Type.Boolean({ description: "Compact with the active model after the audit; this may incur cost" })),
            confirm: Type.Optional(Type.Boolean({ description: "Must be true when compact is requested" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<ContextDoctorToolDetails>> {
          const request = parseToolParams(params);
          const actionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          throwIfAborted(actionSignal);
          const service = runtime();
          if (service === undefined) throw new Error("Pi runtime is not ready");
          refreshReport();
          if (request.compact) {
            if (active !== undefined || queued !== undefined) throw new Error("A context compaction is already in progress");
            if (service.session.isCompacting) throw new Error("A context compaction is already in progress");
            const requestedAt = new Date().toISOString();
            if (service.session.isIdle === false) {
              const onAbort = (): void => {
                if (queued?.signal !== actionSignal) return;
                queued = undefined;
                compaction = {
                  status: "cancelled",
                  requestedAt,
                  finishedAt: new Date().toISOString(),
                  error: "Context compaction was cancelled before it started",
                };
              };
              actionSignal.addEventListener("abort", onAbort, { once: true });
              queued = {
                session: service.session,
                signal: actionSignal,
                requestedAt,
                removeAbortListener: () => actionSignal.removeEventListener("abort", onAbort),
              };
              compaction = { status: "queued", requestedAt };
              const queuedDetails = details(false);
              return {
                content: [{ type: "text", text: "Context compaction queued until the current agent run settles." }],
                details: queuedDetails,
              };
            }
            await waitForOperation(startCompaction(service.session, actionSignal, requestedAt), actionSignal);
          }
          const resultDetails = details(request.compact);
          return {
            content: [
              {
                type: "text",
                text: `${resultDetails.status}: ${resultDetails.messageCount} messages, ${resultDetails.oversizedMessages} oversized, ${resultDetails.toolErrors} tool errors.`,
              },
            ],
            details: resultDetails,
          };
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "context-doctor-panel",
      pluginId: "@pi-harness/plugin-context-doctor",
      title: "Context Doctor",
      description: "安全审计上下文压力、超大或不可测量消息和工具错误，并展示确认压缩的生命周期。",
      icon: "⌁",
      read: () => ({
        ...report(),
        compaction: { ...compaction },
        limits: {
          scannedMessages: maxScannedMessages,
          jsonDepth: maxJsonDepth,
          jsonNodesPerMessage: maxJsonNodes,
          jsonNodesPerAudit: maxJsonNodesPerAudit,
          errorCharacters: maxErrorLength,
        },
      }),
    });
    context.effect(() => disposePanel);
  },
};
