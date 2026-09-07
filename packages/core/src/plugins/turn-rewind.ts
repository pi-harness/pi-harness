import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "../config.js";

const maxCandidates = 50;
const maxScannedEntries = 4_096;
const maxContentParts = 1_000;
const maxText = 500;
const maxEntryIdLength = 200;
const maxEditorTextLength = 4_096;
const maxErrorLength = 2_000;
const parameterNames = new Set(["turns", "entryId", "summarize"]);

function rewindParameters(value: unknown): { turns: number | undefined; entryId: string | undefined; summarize: boolean } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Turn Rewind parameters must be an object");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Turn Rewind parameters must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !parameterNames.has(key)))
    throw new Error("Turn Rewind parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Turn Rewind parameters must use data properties");
  const turns = descriptors.turns?.value as unknown;
  if (turns !== undefined && (!Number.isSafeInteger(turns) || (turns as number) < 1 || (turns as number) > 20))
    throw new Error("Turn Rewind turns must be an integer between 1 and 20");
  const rawEntryId = descriptors.entryId?.value as unknown;
  if (rawEntryId !== undefined && typeof rawEntryId !== "string") throw new Error("Turn Rewind entryId must be a string");
  if (typeof rawEntryId === "string" && rawEntryId.length > maxEntryIdLength)
    throw new Error(`Turn Rewind entryId must contain 1-${maxEntryIdLength} characters`);
  if (typeof rawEntryId === "string" && rawEntryId.includes("\0")) throw new Error("Turn Rewind entryId must not contain NUL characters");
  const entryId = rawEntryId?.trim();
  if (entryId !== undefined && entryId.length < 1) throw new Error(`Turn Rewind entryId must contain 1-${maxEntryIdLength} characters`);
  const summarize = descriptors.summarize?.value as unknown;
  if (summarize !== undefined && typeof summarize !== "boolean") throw new Error("Turn Rewind summarize must be a boolean");
  if (turns !== undefined && entryId !== undefined) throw new Error("Provide Turn Rewind turns or entryId, not both");
  return {
    turns: turns as number | undefined,
    entryId,
    summarize: summarize === true,
  };
}

function boundedError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxErrorLength).replaceAll("\0", "�");
  if (error !== null && typeof error === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string")
      return descriptor.value.slice(0, maxErrorLength).replaceAll("\0", "�");
  }
  return "Unknown session rewind error";
}

function descriptorValue(descriptors: PropertyDescriptorMap, name: string): unknown {
  const descriptor = descriptors[name];
  return descriptor !== undefined && "value" in descriptor ? (descriptor.value as unknown) : undefined;
}

function cancellationError(signal: AbortSignal): Error {
  return new Error("Session rewind request was cancelled", { cause: signal.reason });
}

function waitForNavigation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellationError(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(cancellationError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error("Session rewind failed with a non-Error reason", { cause: error }));
      },
    );
  });
}

export interface RewindCandidate {
  entryId: string;
  text: string;
}

export interface RewindCandidateInventory {
  candidates: RewindCandidate[];
  scannedEntries: number;
  scanTruncated: boolean;
  candidateTruncated: boolean;
}

type RewindSessionManager = {
  getLeafEntry(): unknown;
  getEntry(id: string): unknown;
};

function candidateText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, maxText).replaceAll("\0", "�");
  if (!Array.isArray(content)) return "";
  let result = "";
  for (let index = 0; index < Math.min(content.length, maxContentParts); index += 1) {
    const partDescriptor = Object.getOwnPropertyDescriptor(content, String(index));
    if (partDescriptor === undefined || !("value" in partDescriptor)) continue;
    const part: unknown = partDescriptor.value;
    if (part === null || typeof part !== "object") continue;
    const descriptors = Object.getOwnPropertyDescriptors(part);
    const type = descriptorValue(descriptors, "type");
    const text = descriptorValue(descriptors, "text");
    if (type !== "text" || typeof text !== "string") continue;
    result += text.slice(0, maxText - result.length).replaceAll("\0", "�");
    if (result.length >= maxText) break;
  }
  return result;
}

export function scanRewindCandidates(manager: RewindSessionManager): RewindCandidateInventory {
  const candidates: RewindCandidate[] = [];
  let candidateTruncated = false;
  let scanTruncated = false;
  let scannedEntries = 0;
  let current = manager.getLeafEntry();
  while (current !== undefined && scannedEntries < maxScannedEntries) {
    scannedEntries += 1;
    if (current === null || typeof current !== "object") break;
    const entry = Object.getOwnPropertyDescriptors(current);
    const type = descriptorValue(entry, "type");
    const id = descriptorValue(entry, "id");
    const message = descriptorValue(entry, "message");
    if (
      type === "message" &&
      typeof id === "string" &&
      id.length > 0 &&
      id.length <= maxEntryIdLength &&
      !id.includes("\0") &&
      message !== null &&
      typeof message === "object"
    ) {
      const messageDescriptors = Object.getOwnPropertyDescriptors(message);
      const role = descriptorValue(messageDescriptors, "role");
      const content = descriptorValue(messageDescriptors, "content");
      const text = role === "user" ? candidateText(content) : "";
      if (text !== "") {
        if (candidates.length < maxCandidates) candidates.push({ entryId: id, text });
        else candidateTruncated = true;
      }
    }
    const parentId = descriptorValue(entry, "parentId");
    if (parentId === null) {
      current = undefined;
      break;
    }
    if (typeof parentId !== "string" || parentId.length > maxEntryIdLength || parentId.includes("\0")) break;
    current = manager.getEntry(parentId);
  }
  if (current !== undefined && scannedEntries >= maxScannedEntries) scanTruncated = true;
  candidates.reverse();
  return { candidates, scannedEntries, scanTruncated, candidateTruncated };
}

export interface RewindResult {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  target: RewindCandidate;
  cancelled: boolean;
  editorText?: string;
  error?: string;
  summarized: boolean;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

type RewindRequest = Pick<RewindResult, "target" | "summarized" | "requestedAt">;

function cloneRewindResult(result: RewindResult): RewindResult {
  return { ...result, target: { ...result.target } };
}

export function selectRewindTarget(candidates: readonly RewindCandidate[], turns: number): RewindCandidate | undefined {
  if (!Number.isInteger(turns) || turns < 1 || turns > 20) throw new Error("Turn rewind count must be between 1 and 20");
  if (turns > candidates.length) return undefined;
  return candidates[candidates.length - turns];
}

export default {
  name: "pi-turn-rewind",
  inject: ["piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    let latest: RewindResult | undefined;
    let queued: (RewindRequest & { session: unknown; signal: AbortSignal; removeAbortListener: () => void }) | undefined;
    let active: Promise<RewindResult> | undefined;
    let cachedSession: unknown;
    let candidateInventory: RewindCandidateInventory = {
      candidates: [],
      scannedEntries: 0,
      scanTruncated: false,
      candidateTruncated: false,
    };
    const cloneInventory = (): RewindCandidateInventory => ({
      ...candidateInventory,
      candidates: candidateInventory.candidates.map((candidate) => ({ ...candidate })),
    });
    const refreshCandidateCache = (): RewindCandidateInventory => {
      const session = context.get("piRuntime")?.session;
      cachedSession = session;
      candidateInventory =
        session === undefined
          ? { candidates: [], scannedEntries: 0, scanTruncated: false, candidateTruncated: false }
          : scanRewindCandidates(session.sessionManager);
      return cloneInventory();
    };
    refreshCandidateCache();
    const navigate = async (request: RewindRequest): Promise<RewindResult> => {
      const runtime = context.get("piRuntime");
      if (runtime === undefined) throw new Error("Pi runtime is not ready");
      const startedAt = new Date().toISOString();
      latest = { status: "running", ...request, startedAt, cancelled: false };
      let result: { cancelled: boolean; editorText?: string };
      try {
        // The harness never passes commandContextActions to bindExtensions, so the extension command context installs a no-op navigateTree that resolves {cancelled:false} without moving the session. Call the session operation directly instead.
        result = await runtime.session.navigateTree(request.target.entryId, { summarize: request.summarized });
      } catch (error) {
        latest = { status: "failed", ...request, startedAt, finishedAt: new Date().toISOString(), cancelled: false, error: boundedError(error) };
        throw error;
      }
      const editorText = typeof result.editorText === "string" ? result.editorText.slice(0, maxEditorTextLength).replaceAll("\0", "�") : undefined;
      latest = {
        status: result.cancelled ? "cancelled" : "completed",
        ...request,
        startedAt,
        finishedAt: new Date().toISOString(),
        cancelled: result.cancelled,
        ...(editorText === undefined ? {} : { editorText }),
      };
      refreshCandidateCache();
      return latest;
    };
    const startNavigation = (request: RewindRequest): Promise<RewindResult> => {
      const operation = navigate(request);
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
      if (event.type !== "agent_settled") return;
      if (queued === undefined) {
        refreshCandidateCache();
        return;
      }
      const request = queued;
      queued = undefined;
      request.removeAbortListener();
      if (context.get("piRuntime")?.session !== request.session) {
        latest = {
          status: "cancelled",
          target: request.target,
          summarized: request.summarized,
          requestedAt: request.requestedAt,
          finishedAt: new Date().toISOString(),
          cancelled: true,
          error: "Session changed before the queued rewind could start",
        };
        return;
      }
      void startNavigation({ target: request.target, summarized: request.summarized, requestedAt: request.requestedAt }).catch(() => undefined);
    });
    const unregister = context.piTools.register(
      defineTool({
        name: "session_rewind",
        label: "Rewind session turn",
        description:
          "Navigate the current session branch back to a prior user turn; requests made during a run are queued until the agent settles, then native navigation preserves the abandoned branch.",
        promptSnippet: "rewind the current session to a previous user turn without deleting history",
        promptGuidelines: [
          "Use either turns or entryId, never both.",
          "Set summarize=true only when the user wants a model-generated abandoned-branch summary that may incur cost.",
        ],
        parameters: Type.Object(
          {
            turns: Type.Optional(Type.Integer({ description: "How many user turns to rewind, from 1 to 20", minimum: 1, maximum: 20 })),
            entryId: Type.Optional(Type.String({ description: "Exact native session entry ID to navigate to", minLength: 1, maxLength: maxEntryIdLength })),
            summarize: Type.Optional(Type.Boolean({ description: "Ask Pi to summarize the abandoned branch" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<RewindResult>> {
          const requestParameters = rewindParameters(params);
          if (active !== undefined || queued !== undefined) throw new Error("A session rewind is already in progress");
          const runtime = context.get("piRuntime");
          if (runtime === undefined) throw new Error("Pi runtime is not ready");
          const candidates = refreshCandidateCache().candidates;
          const requestedId = requestParameters.entryId;
          const target = requestedId
            ? candidates.find((candidate) => candidate.entryId === requestedId)
            : selectRewindTarget(candidates, requestParameters.turns ?? 1);
          if (target === undefined) throw new Error("No matching previous user turn was found");
          const request: RewindRequest = { target, summarized: requestParameters.summarize, requestedAt: new Date().toISOString() };
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          if (operationSignal.aborted) {
            latest = {
              status: "cancelled",
              ...request,
              finishedAt: new Date().toISOString(),
              cancelled: true,
              error: "Session rewind was cancelled before it started",
            };
            throw cancellationError(operationSignal);
          }
          if (!runtime.session.isIdle) {
            const onAbort = () => {
              if (queued?.signal !== operationSignal) return;
              queued = undefined;
              latest = {
                status: "cancelled",
                ...request,
                finishedAt: new Date().toISOString(),
                cancelled: true,
                error: "Queued session rewind was cancelled before it started",
              };
            };
            operationSignal.addEventListener("abort", onAbort, { once: true });
            queued = {
              ...request,
              session: runtime.session,
              signal: operationSignal,
              removeAbortListener: () => operationSignal.removeEventListener("abort", onAbort),
            };
            latest = { status: "queued", ...request, cancelled: false };
            return {
              content: [{ type: "text", text: `Session rewind queued until the current agent run settles: ${target.text}` }],
              details: cloneRewindResult(latest),
            };
          }
          const result = await waitForNavigation(startNavigation(request), operationSignal);
          return {
            content: [{ type: "text", text: result.cancelled ? "Session rewind was cancelled." : `Session rewound to: ${target.text}` }],
            details: cloneRewindResult(result),
          };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "turn-rewind-panel",
        pluginId: "@pi-harness/core/plugins/turn-rewind",
        title: "Turn Rewind",
        description: "回到之前的用户轮次并保留原分支，不直接删除会话历史。",
        icon: "↶",
        read: () => {
          if (context.get("piRuntime")?.session !== cachedSession) refreshCandidateCache();
          const inventory = cloneInventory();
          return {
            candidates: inventory.candidates,
            inventory: {
              scannedEntries: inventory.scannedEntries,
              shown: inventory.candidates.length,
              truncated: inventory.scanTruncated || inventory.candidateTruncated,
              scanTruncated: inventory.scanTruncated,
              candidateTruncated: inventory.candidateTruncated,
            },
            latest: latest === undefined ? null : cloneRewindResult(latest),
            limits: {
              candidates: maxCandidates,
              scannedEntries: maxScannedEntries,
              contentParts: maxContentParts,
              previewCharacters: maxText,
              entryIdCharacters: maxEntryIdLength,
              editorTextCharacters: maxEditorTextLength,
              errorCharacters: maxErrorLength,
            },
          };
        },
      });
    } catch (error) {
      lifecycle.abort(new Error("Turn Rewind plugin activation failed", { cause: error }));
      unsubscribe();
      unregister();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Turn Rewind plugin was disposed"));
      unsubscribe();
      unregister();
      disposePanel();
    });
  },
};
