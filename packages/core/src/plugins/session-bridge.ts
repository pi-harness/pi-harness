import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type SessionManager } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "../config.js";

const bridgeVersion = 1 as const;
const maxMessages = 100;
const maxMessageChars = 16_000;
const maxTotalChars = 64_000;
const maxContentParts = 1_000;
const maxAttachments = 100;
const maxSessionIdChars = 256;
const maxCwdChars = 4_096;
const maxModelFieldChars = 256;
const maxMimeTypeChars = 128;
const maxPackageBytes = 256 * 1024;
const maxPackageChars = 256 * 1024;
const maxAttachmentMarkerChars = 256;
const maxDuplicateScanEntries = 10_000;
const maxOperationErrorChars = 2_000;
const bridgeType = "pi-harness/session-bridge";
const roles = new Set(["user", "assistant", "toolResult", "system", "other"]);
const emptyParameterNames = new Set<string>();
const previewParameterNames = new Set(["package"]);
const importParameterNames = new Set(["package", "confirm"]);

export interface BridgeSource {
  sessionId: string;
  cwd: string;
  model?: { provider: string; modelId: string };
}

export interface BridgeMessage {
  role: "user" | "assistant" | "toolResult" | "system" | "other";
  text: string;
  hasImages: boolean;
}

export interface BridgePackage {
  version: typeof bridgeVersion;
  source: BridgeSource;
  createdAt: string;
  messageCount: number;
  messages: BridgeMessage[];
  unresolvedAttachments: string[];
}

export interface HandoffPreview {
  goal: string;
  currentState: string;
  decisions: string[];
  keyFiles: string[];
  nextStep: string;
}

type BridgeOperation = "export" | "preview" | "import";
type BridgeStatus = {
  state: "idle" | "running" | "completed" | "failed" | "cancelled";
  operation?: BridgeOperation;
  at?: string;
  error?: string;
};

function cloneSource(source: BridgeSource): BridgeSource {
  return { sessionId: source.sessionId, cwd: source.cwd, ...(source.model === undefined ? {} : { model: { ...source.model } }) };
}

type MessageInput = { role?: unknown; content?: unknown };

function contentPart(value: unknown): { type?: unknown; text?: unknown; mimeType?: unknown } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) return undefined;
  return {
    type: descriptors.type?.value,
    text: descriptors.text?.value,
    mimeType: descriptors.mimeType?.value,
  };
}

function mimeType(value: unknown): string {
  if (typeof value !== "string" || value.length > maxMimeTypeChars) return "image/unknown";
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/iu.test(normalized) ? normalized : "image/unknown";
}

function textContent(content: unknown): { text: string; imageTypes: string[] } {
  if (typeof content === "string") return { text: content.slice(0, maxMessageChars), imageTypes: [] };
  if (!Array.isArray(content)) return { text: "", imageTypes: [] };
  const text: string[] = [];
  const imageTypes: string[] = [];
  let textChars = 0;
  for (const item of content.slice(0, maxContentParts)) {
    const value = contentPart(item);
    if (value === undefined) continue;
    if (value.type === "text" && typeof value.text === "string" && textChars < maxMessageChars) {
      const separator = text.length === 0 ? 0 : 1;
      const retained = value.text.slice(0, Math.max(0, maxMessageChars - textChars - separator));
      if (retained !== "") {
        text.push(retained);
        textChars += separator + retained.length;
      }
    }
    if (value.type === "image" && imageTypes.length < maxAttachments) imageTypes.push(mimeType(value.mimeType));
  }
  return { text: text.join("\n"), imageTypes };
}

function role(value: unknown): BridgeMessage["role"] {
  return typeof value === "string" && roles.has(value) ? (value as BridgeMessage["role"]) : "other";
}

function dataPropertyDescriptors(value: unknown, label: string): PropertyDescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error(`${label} must use data properties`);
  return descriptors;
}

function boundedSourceText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL characters`);
  return value.slice(0, maximum);
}

const previewTextLimit = 1_000;
const previewListLimit = 8;

function boundedPreviewText(value: string): string {
  const normalized = value.trim();
  return normalized.length <= previewTextLimit ? normalized : `${normalized.slice(0, previewTextLimit - 1)}…`;
}

function extractKeyFiles(messages: readonly BridgeMessage[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:^|[^\w@])((?:\.\.?\/|[\w-]+\/)+[\w.-]+\.[a-z0-9]{1,12}|[\w.-]+\.(?:json|toml|yaml|yml|md|ts|tsx|js|jsx|rs|go|py|swift|css|html))(?![\w])/giu;
  for (const message of messages) {
    for (const match of message.text.matchAll(pattern)) {
      const file = match[1];
      if (file !== undefined && !seen.has(file)) {
        seen.add(file);
        files.push(file);
        if (files.length === previewListLimit) return files;
      }
    }
  }
  return files;
}

export function buildHandoffPreview(packageValue: BridgePackage): HandoffPreview {
  const userMessages = packageValue.messages.filter((message) => message.role === "user" && message.text.trim() !== "");
  const assistantMessages = packageValue.messages.filter((message) => message.role === "assistant" && message.text.trim() !== "");
  const goal = boundedPreviewText(userMessages[0]?.text ?? "No explicit goal was found in the source session.");
  const currentState = boundedPreviewText(assistantMessages.at(-1)?.text ?? "No assistant progress message was found.");
  const decisions = userMessages
    .filter((message) => /(?:\b(?:fix|keep|use|avoid|must|should|decide|preserve)\b|不要|保持|使用|改|修复|决定)/iu.test(message.text))
    .slice(0, previewListLimit)
    .map((message) => boundedPreviewText(message.text));
  const nextStep = boundedPreviewText(userMessages.at(-1)?.text ?? "Continue from the current state after reviewing this preview.");
  return { goal, currentState, decisions, keyFiles: extractKeyFiles(packageValue.messages), nextStep };
}

function serializedBytes(value: BridgePackage): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fitSerializedPackage(packageValue: BridgePackage): BridgePackage {
  if (serializedBytes(packageValue) <= maxPackageBytes) return packageValue;
  const messages = packageValue.messages.map((message) => ({ ...message, text: "" }));
  const bounded = { ...packageValue, messages };
  let remainingBytes = maxPackageBytes - serializedBytes(bounded);
  if (remainingBytes < 0) throw new Error("Session Bridge package metadata exceeds the serialized byte limit");

  let exhausted = false;
  for (let index = 0; index < messages.length && !exhausted; index += 1) {
    const retained: string[] = [];
    for (const character of packageValue.messages[index]?.text ?? "") {
      const characterBytes = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
      if (characterBytes > remainingBytes) {
        exhausted = true;
        break;
      }
      retained.push(character);
      remainingBytes -= characterBytes;
    }
    const message = messages[index];
    if (message !== undefined) message.text = retained.join("");
  }
  if (serializedBytes(bounded) > maxPackageBytes) throw new Error("Session Bridge package exceeds the serialized byte limit");
  return bounded;
}

export function buildBridgePackage(source: BridgeSource, input: readonly MessageInput[]): BridgePackage {
  const sourceDescriptors = dataPropertyDescriptors(source, "Session Bridge source");
  const sessionId = boundedSourceText(sourceDescriptors.sessionId?.value, "Session Bridge source sessionId", maxSessionIdChars);
  const cwd = boundedSourceText(sourceDescriptors.cwd?.value, "Session Bridge source cwd", maxCwdChars);
  const rawModel = sourceDescriptors.model?.value as unknown;
  let model: BridgeSource["model"];
  if (rawModel !== undefined) {
    const modelDescriptors = dataPropertyDescriptors(rawModel, "Session Bridge source model");
    model = {
      provider: boundedSourceText(modelDescriptors.provider?.value, "Session Bridge model provider", maxModelFieldChars),
      modelId: boundedSourceText(modelDescriptors.modelId?.value, "Session Bridge model id", maxModelFieldChars),
    };
  }
  const messages: BridgeMessage[] = [];
  const unresolvedAttachments: string[] = [];
  let totalChars = 0;
  for (const [index, message] of input.slice(-maxMessages).entries()) {
    const descriptors = message !== null && typeof message === "object" ? Object.getOwnPropertyDescriptors(message) : {};
    const safe = Object.values(descriptors).every((descriptor) => "value" in descriptor);
    const content = textContent(safe ? descriptors.content?.value : undefined);
    const text = content.text.slice(0, maxMessageChars);
    if (text !== "") totalChars += text.length;
    const boundedText = totalChars > maxTotalChars ? text.slice(0, Math.max(0, maxTotalChars - (totalChars - text.length))) : text;
    messages.push({ role: role(safe ? descriptors.role?.value : undefined), text: boundedText, hasImages: content.imageTypes.length > 0 });
    for (const type of content.imageTypes) {
      if (unresolvedAttachments.length === maxAttachments) break;
      unresolvedAttachments.push(`message-${index + 1}:${type}`);
    }
    if (totalChars >= maxTotalChars) break;
  }
  return fitSerializedPackage({
    version: bridgeVersion,
    source: { sessionId, cwd, ...(model === undefined ? {} : { model }) },
    createdAt: new Date().toISOString(),
    messageCount: messages.length,
    messages,
    unresolvedAttachments,
  });
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const names = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !names.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown properties: ${unknown.join(", ")}`);
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters`);
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL characters`);
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parameterDescriptors(value: unknown, names: ReadonlySet<string>): PropertyDescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Session Bridge parameters must be an object");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Session Bridge parameters must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !names.has(key)))
    throw new Error("Session Bridge parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Session Bridge parameters must use data properties");
  return descriptors;
}

function packageParameter(value: unknown, required: true): string;
function packageParameter(value: unknown, required: false): string | undefined;
function packageParameter(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error("Session Bridge package must be a non-empty string");
  if (value.length > maxPackageChars) throw new Error("Session Bridge package exceeds the character limit");
  return value;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Session Bridge operation was cancelled", { cause: signal.reason });
}

function boundedError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxOperationErrorChars);
  if (error !== null && typeof error === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value.slice(0, maxOperationErrorChars);
  }
  return "Unknown Session Bridge error";
}

export function parseBridgePackage(raw: string): BridgePackage {
  if (typeof raw !== "string") throw new Error("Session bridge package must be a string");
  if (Buffer.byteLength(raw, "utf8") > maxPackageBytes) throw new Error("Session bridge package exceeds the 256 KiB limit");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Session bridge package is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Session bridge package must be an object");
  const packageValue = value as Record<string, unknown>;
  assertKeys(packageValue, ["version", "source", "createdAt", "messageCount", "messages", "unresolvedAttachments"], "Session bridge package");
  if (packageValue.version !== bridgeVersion) throw new Error("Session bridge package version must be 1");
  const source = packageValue.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) throw new Error("Session bridge package source is required");
  const sourceValue = source as Record<string, unknown>;
  assertKeys(sourceValue, ["sessionId", "cwd", "model"], "Session bridge package source");
  const sessionId = requiredText(sourceValue.sessionId, "Session bridge source sessionId", maxSessionIdChars);
  const cwd = requiredText(sourceValue.cwd, "Session bridge source cwd", maxCwdChars);
  if (!isIsoTimestamp(packageValue.createdAt)) throw new Error("Session bridge package createdAt must be an ISO timestamp");
  const messages = packageValue.messages;
  if (!Array.isArray(messages) || messages.length > maxMessages) throw new Error(`Session bridge package must contain 0-${maxMessages} messages`);
  let totalChars = 0;
  const normalized = messages.map((message, index) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) throw new Error(`Session bridge message ${index + 1} is invalid`);
    const item = message as Record<string, unknown>;
    assertKeys(item, ["role", "text", "hasImages"], `Session bridge message ${index + 1}`);
    if (
      typeof item.role !== "string" ||
      !roles.has(item.role) ||
      typeof item.text !== "string" ||
      item.text.length > maxMessageChars ||
      typeof item.hasImages !== "boolean"
    )
      throw new Error(`Session bridge message ${index + 1} is invalid`);
    totalChars += item.text.length;
    if (totalChars > maxTotalChars) throw new Error("Session bridge message text exceeds the 64 KiB limit");
    return { role: item.role as BridgeMessage["role"], text: item.text, hasImages: item.hasImages };
  });
  if (!Number.isSafeInteger(packageValue.messageCount) || packageValue.messageCount !== normalized.length)
    throw new Error("Session bridge package messageCount must match the messages array");
  const rawAttachments = packageValue.unresolvedAttachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length > maxAttachments) throw new Error("Session bridge attachment markers are invalid");
  const attachments: string[] = [];
  const seenAttachments = new Set<string>();
  for (const item of rawAttachments as unknown[]) {
    if (typeof item !== "string" || item.length === 0 || item.length > maxAttachmentMarkerChars || seenAttachments.has(item))
      throw new Error("Session bridge attachment markers are invalid");
    const match = /^message-([1-9]\d{0,2}):(.+)$/u.exec(item);
    const messageIndex = match === null ? 0 : Number(match[1]);
    const attachmentType = match?.[2];
    if (
      match === null ||
      messageIndex > normalized.length ||
      normalized[messageIndex - 1]?.hasImages !== true ||
      attachmentType === undefined ||
      mimeType(attachmentType) !== attachmentType
    )
      throw new Error("Session bridge attachment markers are invalid");
    seenAttachments.add(item);
    attachments.push(item);
  }
  const model = sourceValue.model;
  let normalizedModel: BridgeSource["model"];
  if (model !== undefined) {
    if (model === null || typeof model !== "object" || Array.isArray(model)) throw new Error("Session bridge source model is invalid");
    const modelRecord = model as Record<string, unknown>;
    assertKeys(modelRecord, ["provider", "modelId"], "Session bridge source model");
    normalizedModel = {
      provider: requiredText(modelRecord.provider, "Session bridge model provider", maxModelFieldChars),
      modelId: requiredText(modelRecord.modelId, "Session bridge model id", maxModelFieldChars),
    };
  }
  return {
    version: bridgeVersion,
    source: { sessionId, cwd, ...(normalizedModel === undefined ? {} : { model: normalizedModel }) },
    createdAt: packageValue.createdAt,
    messageCount: normalized.length,
    messages: normalized,
    unresolvedAttachments: [...attachments],
  };
}

function importedText(packageValue: BridgePackage): string {
  const model = packageValue.source.model === undefined ? "unknown model" : `${packageValue.source.model.provider}/${packageValue.source.model.modelId}`;
  const lines = [`Session handoff from ${packageValue.source.sessionId} (${packageValue.source.cwd})`, `Source model: ${model}`, ""];
  for (const message of packageValue.messages) {
    lines.push(`[${message.role}]`, message.text || "(no text)");
    if (message.hasImages) lines.push("[unresolved image attachment]");
    lines.push("");
  }
  if (packageValue.unresolvedAttachments.length > 0) lines.push(`Unresolved attachments: ${packageValue.unresolvedAttachments.join(", ")}`);
  return lines.join("\n").trim();
}

function bridgeDigest(packageValue: BridgePackage): string {
  return createHash("sha256").update(JSON.stringify(packageValue)).digest("hex");
}

function importedBridgeDigest(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(entry);
  if (descriptors.type?.value !== "custom_message" || descriptors.customType?.value !== bridgeType) return undefined;
  const details = descriptors.details?.value as unknown;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const digestDescriptor = Object.getOwnPropertyDescriptor(details, "digest");
  return digestDescriptor !== undefined && "value" in digestDescriptor && typeof digestDescriptor.value === "string" ? digestDescriptor.value : undefined;
}

function wasImported(manager: SessionManager, digest: string): boolean {
  const entries = manager.getEntries();
  const start = Math.max(0, entries.length - maxDuplicateScanEntries);
  for (let index = entries.length - 1; index >= start; index -= 1) if (importedBridgeDigest(entries[index]) === digest) return true;
  return false;
}

export default {
  name: "pi-session-bridge",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    let latest: { direction: "export" | "import"; sessionId: string; messages: number; attachments: number; at: string } | undefined;
    let latestPreview: { source: BridgeSource; preview: HandoffPreview; at: string } | undefined;
    let status: BridgeStatus = { state: "idle" };
    let currentPreviewCache: HandoffPreview | undefined;
    let currentPreviewManager: SessionManager | undefined;
    let currentPreviewDirty = true;
    const activeManager = (): SessionManager => context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager;
    const exportCurrentSession = (manager = activeManager()): BridgePackage => {
      const current = manager.buildSessionContext();
      const model = current.model === null ? undefined : current.model;
      return buildBridgePackage({ sessionId: manager.getSessionId(), cwd: manager.getCwd(), ...(model === undefined ? {} : { model }) }, current.messages);
    };
    const currentPreview = (): HandoffPreview => {
      const manager = activeManager();
      if (currentPreviewCache === undefined || currentPreviewDirty || manager !== currentPreviewManager) {
        currentPreviewCache = buildHandoffPreview(exportCurrentSession(manager));
        currentPreviewManager = manager;
        currentPreviewDirty = false;
      }
      return structuredClone(currentPreviewCache);
    };
    const invalidatePreview = context.on("pi/session-event", () => {
      currentPreviewDirty = true;
    });
    const runOperation = <T>(operation: BridgeOperation, callerSignal: AbortSignal | undefined, action: (signal: AbortSignal) => T): Promise<T> => {
      const operationSignal = callerSignal === undefined ? lifecycle.signal : AbortSignal.any([callerSignal, lifecycle.signal]);
      status = { state: "running", operation };
      return Promise.resolve()
        .then(() => action(operationSignal))
        .then(
          (result) => {
            status = { state: "completed", operation, at: new Date().toISOString() };
            return result;
          },
          (error: unknown) => {
            status = {
              state: operationSignal.aborted ? "cancelled" : "failed",
              operation,
              at: new Date().toISOString(),
              error: boundedError(error),
            };
            throw error;
          },
        );
    };
    const unregisterExport = context.piTools.register(
      defineTool({
        name: "session_bridge_export",
        label: "Export session handoff",
        description: "Export the active conversation as a bounded, reviewable handoff package without modifying the source session.",
        promptSnippet: "export the current session as a handoff package",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<BridgePackage>> {
          return runOperation("export", signal, (operationSignal) => {
            parameterDescriptors(rawParams, emptyParameterNames);
            throwIfCancelled(operationSignal);
            const packageValue = exportCurrentSession();
            throwIfCancelled(operationSignal);
            latest = {
              direction: "export",
              sessionId: packageValue.source.sessionId,
              messages: packageValue.messageCount,
              attachments: packageValue.unresolvedAttachments.length,
              at: packageValue.createdAt,
            };
            return { content: [{ type: "text" as const, text: JSON.stringify(packageValue) }], details: packageValue };
          });
        },
      }),
    );
    const unregisterPreview = context.piTools.register(
      defineTool({
        name: "session_bridge_preview",
        label: "Preview session handoff",
        description: "Create a bounded five-part handoff preview without creating a target session or changing the source session.",
        promptSnippet: "preview the current session handoff before migration",
        parameters: Type.Object(
          {
            package: Type.Optional(Type.String({ description: "Optional JSON produced by session_bridge_export", minLength: 1, maxLength: maxPackageChars })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ source: BridgeSource; preview: HandoffPreview }>> {
          return runOperation("preview", signal, (operationSignal) => {
            const descriptors = parameterDescriptors(rawParams, previewParameterNames);
            throwIfCancelled(operationSignal);
            const packageText = packageParameter(descriptors.package?.value, false);
            const packageValue = packageText === undefined ? exportCurrentSession() : parseBridgePackage(packageText);
            throwIfCancelled(operationSignal);
            const preview = buildHandoffPreview(packageValue);
            latestPreview = { source: cloneSource(packageValue.source), preview: structuredClone(preview), at: new Date().toISOString() };
            return {
              content: [{ type: "text" as const, text: `Prepared a five-part handoff preview for ${packageValue.source.sessionId}.` }],
              details: { source: cloneSource(packageValue.source), preview: structuredClone(preview) },
            };
          });
        },
      }),
    );
    const unregisterImport = context.piTools.register(
      defineTool({
        name: "session_bridge_import",
        label: "Import session handoff",
        description: "Validate a handoff package and append it to the current session as a visible context message; the source session remains untouched.",
        promptSnippet: "import a validated session handoff package",
        parameters: Type.Object(
          {
            package: Type.String({ description: "JSON produced by session_bridge_export", minLength: 1, maxLength: maxPackageChars }),
            confirm: Type.Boolean({ description: "Must be true to append the handoff to the current LLM context" }),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ imported: true; source: BridgeSource; messages: number }>> {
          return runOperation("import", signal, (operationSignal) => {
            const descriptors = parameterDescriptors(rawParams, importParameterNames);
            throwIfCancelled(operationSignal);
            if (descriptors.confirm?.value !== true) throw new Error("Session Bridge import requires confirm=true");
            const packageText = packageParameter(descriptors.package?.value, true);
            const packageValue = parseBridgePackage(packageText);
            throwIfCancelled(operationSignal);
            const targetManager = activeManager();
            const digest = bridgeDigest(packageValue);
            if (wasImported(targetManager, digest)) throw new Error("This Session Bridge handoff was already imported into the active session");
            targetManager.appendCustomMessageEntry(bridgeType, importedText(packageValue), true, {
              source: cloneSource(packageValue.source),
              messageCount: packageValue.messageCount,
              digest,
            });
            currentPreviewDirty = true;
            latest = {
              direction: "import",
              sessionId: packageValue.source.sessionId,
              messages: packageValue.messageCount,
              attachments: packageValue.unresolvedAttachments.length,
              at: new Date().toISOString(),
            };
            return {
              content: [{ type: "text" as const, text: `Imported ${packageValue.messageCount} handoff message(s).` }],
              details: { imported: true, source: cloneSource(packageValue.source), messages: packageValue.messageCount },
            };
          });
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "session-bridge-panel",
        pluginId: "@pi-harness/core/plugins/session-bridge",
        title: "Session Bridge",
        description: "导出或导入可审查的会话交接包，不改写源会话树。",
        icon: "⇄",
        read: () => ({
          latest: latest === undefined ? null : { ...latest },
          latestPreview:
            latestPreview === undefined
              ? null
              : { source: cloneSource(latestPreview.source), preview: structuredClone(latestPreview.preview), at: latestPreview.at },
          status: { ...status },
          currentPreview: currentPreview(),
          formatVersion: bridgeVersion,
          maxMessages,
          maxTotalChars,
          limits: {
            packageBytes: maxPackageBytes,
            packageCharacters: maxPackageChars,
            messages: maxMessages,
            messageCharacters: maxMessageChars,
            totalMessageCharacters: maxTotalChars,
            contentParts: maxContentParts,
            attachments: maxAttachments,
            attachmentMarkerCharacters: maxAttachmentMarkerChars,
            sessionIdCharacters: maxSessionIdChars,
            cwdCharacters: maxCwdChars,
            modelFieldCharacters: maxModelFieldChars,
            previewTextCharacters: previewTextLimit,
            previewListItems: previewListLimit,
            duplicateScanEntries: maxDuplicateScanEntries,
            operationErrorCharacters: maxOperationErrorChars,
          },
        }),
      });
    } catch (error) {
      lifecycle.abort(new Error("Session Bridge plugin activation failed", { cause: error }));
      invalidatePreview();
      unregisterExport();
      unregisterImport();
      unregisterPreview();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Session Bridge plugin was disposed"));
      invalidatePreview();
      unregisterExport();
      unregisterImport();
      unregisterPreview();
      disposePanel();
    });
  },
};
