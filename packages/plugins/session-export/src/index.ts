import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, atomicWriteFile, prepareWorkspaceFile } from "@pi-harness/plugin-api";

const maxOutputBytes = 1024 * 1024;
const defaultFileName = "pi-session.md";

type ExportState = { path: string; bytes: number; messages: number; sourceMessages: number; omittedMessages: number; sessionId: string; workspace: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .filter(Boolean)
    .join("\n");
}

function heading(role: string, toolName: string | undefined): string {
  if (role === "toolResult") return `### Tool: ${toolName?.trim() || "unknown"}`;
  return `## ${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

function renderSession(messages: readonly unknown[]): { markdown: string; messages: number; omittedMessages: number } {
  const sections: string[] = [];
  let bytes = Buffer.byteLength("# Pi Harness Session\n\n");
  for (const message of messages) {
    const item = record(message);
    if (item === undefined || typeof item.role !== "string") continue;
    const text = contentText(item.content);
    if (text.trim() === "") continue;
    const section = `${heading(item.role, typeof item.toolName === "string" ? item.toolName : undefined)}\n\n${text}`;
    bytes += Buffer.byteLength(section, "utf8") + (sections.length === 0 ? 1 : 2);
    if (bytes > maxOutputBytes) throw new Error("Session export exceeds the 1 MiB output limit");
    sections.push(section);
  }
  return {
    markdown: `# Pi Harness Session\n\n${sections.length > 0 ? `${sections.join("\n\n")}\n` : ""}`,
    messages: sections.length,
    omittedMessages: messages.length - sections.length,
  };
}

export function renderSessionMarkdown(messages: readonly unknown[]): string {
  return renderSession(messages).markdown;
}

function normalizedOutputPath(requested: string): string {
  const normalized = requested.trim() || defaultFileName;
  if (normalized.length > 256) throw new Error("Session export path must be at most 256 characters");
  if (!normalized.toLowerCase().endsWith(".md")) throw new Error("Session export path must end with .md");
  return normalized;
}

export default {
  name: "pi-session-export",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: ExportState | undefined;
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort(new Error("Session export was cancelled")));
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "session_export",
        label: "Export session",
        description: "Export the current Pi session as bounded Markdown without changing the conversation history.",
        promptSnippet: "export the current session to a Markdown file",
        parameters: Type.Object(
          {
            path: Type.Optional(Type.String({ description: "Markdown path relative to the workspace" })),
            confirm: Type.Optional(Type.Boolean({ description: "Must be true to overwrite an existing file" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<ExportState>> {
          const combined = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const check = (): void => {
            if (combined.aborted) throw new Error("Session export was cancelled");
          };
          check();
          if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) throw new Error("Session export parameters must be an object");
          const descriptors = Object.getOwnPropertyDescriptors(rawParams);
          if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !["path", "confirm"].includes(key) || !("value" in descriptors[key]!)))
            throw new Error("Invalid session export property");
          const path: unknown = descriptors.path?.value;
          const confirm: unknown = descriptors.confirm?.value;
          if (path !== undefined && (typeof path !== "string" || path.includes("\0"))) throw new Error("Session export path must be a string without NUL");
          if (confirm !== undefined && typeof confirm !== "boolean") throw new Error("Session export confirm must be a boolean");
          const runtime = context.get("piRuntime");
          if (runtime === undefined) throw new Error("Pi runtime is not ready");
          const session = runtime.session;
          const workspace = session.sessionManager.getCwd();
          const sessionId = session.sessionManager.getSessionId();
          const sourceMessages = session.messages.length;
          const rendered = renderSession(session.messages);
          const bytes = Buffer.byteLength(rendered.markdown, "utf8");
          const prepared = await prepareWorkspaceFile(
            workspace,
            normalizedOutputPath(path ?? defaultFileName),
            "Session export path must stay inside the current workspace and target a regular file",
          );
          check();
          if (prepared.exists && confirm !== true) throw new Error("Session export would overwrite an existing file; retry with confirm=true");
          try {
            await atomicWriteFile(prepared.target, rendered.markdown, { encoding: "utf8", mode: 0o600, overwrite: confirm === true, signal: combined });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
              throw new Error("Session export would overwrite an existing file; retry with confirm=true", { cause: error });
            throw error;
          }
          const result = {
            path: prepared.relativePath,
            bytes,
            messages: rendered.messages,
            sourceMessages,
            omittedMessages: rendered.omittedMessages,
            sessionId,
            workspace,
          };
          latest = { ...result };
          return {
            content: [
              {
                type: "text",
                text: `Session ${sessionId} exported to ${workspace}/${result.path}: ${result.messages} text sections; ${result.omittedMessages} messages without text omitted. Images, thinking and tool-call payloads are not exported.`,
              },
            ],
            details: result,
          };
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "session-export-panel",
      pluginId: "@pi-harness/plugin-session-export",
      title: "Session Export",
      description: "将当前会话导出为工作区内的 Markdown 文件，不改变原会话历史。",
      icon: "⇩",
      read: () => ({ latest: latest === undefined ? null : { ...latest }, maxOutputBytes }),
    });
    context.effect(() => disposePanel);
  },
};
