import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { prepareWorkspaceFile } from "../workspace-path.js";

const maxOutputBytes = 1024 * 1024;
const defaultFileName = "pi-session.md";

type ExportState = { path: string; bytes: number; messages: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? [item.text.trim()] : [];
    })
    .filter(Boolean)
    .join("\n");
}

function heading(role: string, toolName: string | undefined): string {
  if (role === "toolResult") return `### Tool: ${toolName?.trim() || "unknown"}`;
  return `## ${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

export function renderSessionMarkdown(messages: readonly unknown[]): string {
  const sections = messages.flatMap((message) => {
    const item = record(message);
    if (item === undefined || typeof item.role !== "string") return [];
    const text = contentText(item.content);
    return text === "" ? [] : [`${heading(item.role, typeof item.toolName === "string" ? item.toolName : undefined)}\n\n${text}`];
  });
  return `# Pi Harness Session\n\n${sections.length > 0 ? `${sections.join("\n\n")}\n` : ""}`;
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
  apply(context: Context) {
    let latest: ExportState | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "session_export",
        label: "Export session",
        description: "Export the current Pi session as bounded Markdown without changing the conversation history.",
        promptSnippet: "export the current session to a Markdown file",
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: "Markdown path relative to the workspace" })),
          confirm: Type.Optional(Type.Boolean({ description: "Must be true to overwrite an existing file" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<ExportState>> {
          const runtime = context.get("piRuntime");
          if (runtime === undefined) throw new Error("Pi runtime is not ready");
          const prepared = await prepareWorkspaceFile(
            context.piHarnessLaunch.cwd,
            normalizedOutputPath(params.path ?? defaultFileName),
            "Session export path must stay inside the current workspace and target a regular file",
          );
          if (prepared.exists && params.confirm !== true) throw new Error("Session export would overwrite an existing file; retry with confirm=true");
          const markdown = renderSessionMarkdown(runtime.session.messages);
          const bytes = Buffer.byteLength(markdown, "utf8");
          if (bytes > maxOutputBytes) throw new Error("Session export exceeds the 1 MiB output limit");
          const temporary = `${prepared.target}.${randomUUID()}.tmp`;
          await writeFile(temporary, markdown, { encoding: "utf8", mode: 0o600 });
          await rename(temporary, prepared.target);
          latest = { path: prepared.relativePath, bytes, messages: runtime.session.messages.length };
          return { content: [{ type: "text", text: `Session exported to ${latest.path}.` }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "session-export-panel",
      pluginId: "@pi-harness/core/plugins/session-export",
      title: "Session Export",
      description: "将当前会话导出为工作区内的 Markdown 文件，不改变原会话历史。",
      icon: "⇩",
      read: () => ({ latest: latest ?? null, maxOutputBytes }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
