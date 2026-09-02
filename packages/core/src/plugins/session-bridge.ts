import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const bridgeVersion = 1 as const;
const maxMessages = 100;
const maxMessageChars = 16_000;
const maxTotalChars = 64_000;
const bridgeType = "pi-harness/session-bridge";
const roles = new Set(["user", "assistant", "toolResult", "system", "other"]);

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

type MessageInput = { role?: unknown; content?: unknown };

function textContent(content: unknown): { text: string; imageTypes: string[] } {
  if (typeof content === "string") return { text: content, imageTypes: [] };
  if (!Array.isArray(content)) return { text: "", imageTypes: [] };
  const text: string[] = [];
  const imageTypes: string[] = [];
  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    const value = item as { type?: unknown; text?: unknown; mimeType?: unknown };
    if (value.type === "text" && typeof value.text === "string") text.push(value.text);
    if (value.type === "image") imageTypes.push(typeof value.mimeType === "string" && value.mimeType.trim() !== "" ? value.mimeType : "image/unknown");
  }
  return { text: text.join("\n"), imageTypes };
}

function role(value: unknown): BridgeMessage["role"] {
  return typeof value === "string" && roles.has(value) ? (value as BridgeMessage["role"]) : "other";
}

export function buildBridgePackage(source: BridgeSource, input: readonly MessageInput[]): BridgePackage {
  const messages: BridgeMessage[] = [];
  const unresolvedAttachments: string[] = [];
  let totalChars = 0;
  for (const [index, message] of input.slice(-maxMessages).entries()) {
    const content = textContent(message.content);
    const text = content.text.slice(0, maxMessageChars);
    if (text !== "") totalChars += text.length;
    const boundedText = totalChars > maxTotalChars ? text.slice(0, Math.max(0, maxTotalChars - (totalChars - text.length))) : text;
    messages.push({ role: role(message.role), text: boundedText, hasImages: content.imageTypes.length > 0 });
    for (const type of content.imageTypes) unresolvedAttachments.push(`message-${index + 1}:${type}`);
    if (totalChars >= maxTotalChars) break;
  }
  return {
    version: bridgeVersion,
    source: { sessionId: source.sessionId, cwd: source.cwd, ...(source.model === undefined ? {} : { model: { ...source.model } }) },
    createdAt: new Date().toISOString(),
    messageCount: messages.length,
    messages,
    unresolvedAttachments,
  };
}

export function parseBridgePackage(raw: string): BridgePackage {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("Session bridge package exceeds the 256 KiB limit");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Session bridge package is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Session bridge package must be an object");
  const packageValue = value as Record<string, unknown>;
  if (packageValue.version !== bridgeVersion) throw new Error("Session bridge package version must be 1");
  const source = packageValue.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) throw new Error("Session bridge package source is required");
  const sourceValue = source as Record<string, unknown>;
  if (typeof sourceValue.sessionId !== "string" || typeof sourceValue.cwd !== "string")
    throw new Error("Session bridge package source requires sessionId and cwd");
  const messages = packageValue.messages;
  if (!Array.isArray(messages) || messages.length > maxMessages) throw new Error(`Session bridge package must contain 0-${maxMessages} messages`);
  let totalChars = 0;
  const normalized = messages.map((message, index) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) throw new Error(`Session bridge message ${index + 1} is invalid`);
    const item = message as Record<string, unknown>;
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
  const rawAttachments = packageValue.unresolvedAttachments;
  if (!Array.isArray(rawAttachments)) throw new Error("Session bridge attachment markers are invalid");
  const attachments = (rawAttachments as unknown[]).filter((item): item is string => typeof item === "string" && item.length <= 256);
  if (attachments.length !== rawAttachments.length) throw new Error("Session bridge attachment markers are invalid");
  const model = sourceValue.model;
  const modelRecord = model !== null && typeof model === "object" && !Array.isArray(model) ? (model as Record<string, unknown>) : undefined;
  const provider = typeof modelRecord?.provider === "string" ? modelRecord.provider : undefined;
  const modelId = typeof modelRecord?.modelId === "string" ? modelRecord.modelId : undefined;
  const normalizedModel = provider === undefined || modelId === undefined ? undefined : { provider, modelId };
  const sessionId = sourceValue.sessionId;
  const cwd = sourceValue.cwd;
  return {
    version: bridgeVersion,
    source: { sessionId, cwd, ...(normalizedModel === undefined ? {} : { model: normalizedModel }) },
    createdAt: typeof packageValue.createdAt === "string" ? packageValue.createdAt : "",
    messageCount: normalized.length,
    messages: normalized,
    unresolvedAttachments: [...attachments],
  };
}

function sessionMessages(context: Context): MessageInput[] {
  return context.piSession.manager.buildSessionContext().messages.map((message) => {
    const value = message as unknown as MessageInput;
    return { role: value.role, content: value.content };
  });
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

export default {
  name: "pi-session-bridge",
  inject: ["piSession", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: { direction: "export" | "import"; sessionId: string; messages: number; attachments: number; at: string } | undefined;
    const unregisterExport = context.piTools.register(
      defineTool({
        name: "session_bridge_export",
        label: "Export session handoff",
        description: "Export the active conversation as a bounded, reviewable handoff package without modifying the source session.",
        promptSnippet: "export the current session as a handoff package",
        parameters: Type.Object({}),
        execute(): Promise<AgentToolResult<BridgePackage>> {
          const manager = context.piSession.manager;
          const current = manager.buildSessionContext();
          const model = current.model === null ? undefined : current.model;
          const packageValue = buildBridgePackage(
            { sessionId: manager.getSessionId(), cwd: manager.getCwd(), ...(model === undefined ? {} : { model }) },
            sessionMessages(context),
          );
          latest = {
            direction: "export",
            sessionId: packageValue.source.sessionId,
            messages: packageValue.messageCount,
            attachments: packageValue.unresolvedAttachments.length,
            at: packageValue.createdAt,
          };
          return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(packageValue) }], details: packageValue });
        },
      }),
    );
    const unregisterImport = context.piTools.register(
      defineTool({
        name: "session_bridge_import",
        label: "Import session handoff",
        description: "Validate a handoff package and append it to the current session as a visible context message; the source session remains untouched.",
        promptSnippet: "import a validated session handoff package",
        parameters: Type.Object({ package: Type.String({ description: "JSON produced by session_bridge_export" }) }),
        execute(_toolCallId, params): Promise<AgentToolResult<{ imported: true; source: BridgeSource; messages: number }>> {
          const packageValue = parseBridgePackage(params.package);
          context.piSession.manager.appendCustomMessageEntry(bridgeType, importedText(packageValue), true, {
            source: packageValue.source,
            messageCount: packageValue.messageCount,
          });
          latest = {
            direction: "import",
            sessionId: packageValue.source.sessionId,
            messages: packageValue.messageCount,
            attachments: packageValue.unresolvedAttachments.length,
            at: new Date().toISOString(),
          };
          return Promise.resolve({
            content: [{ type: "text", text: `Imported ${packageValue.messageCount} handoff message(s).` }],
            details: { imported: true, source: packageValue.source, messages: packageValue.messageCount },
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "session-bridge-panel",
      pluginId: "@pi-harness/core/plugins/session-bridge",
      title: "Session Bridge",
      description: "导出或导入可审查的会话交接包，不改写源会话树。",
      icon: "⇄",
      read: () => ({ latest: latest ?? null, formatVersion: bridgeVersion, maxMessages, maxTotalChars }),
    });
    context.effect(() => () => {
      unregisterExport();
      unregisterImport();
      disposePanel();
    });
  },
};
