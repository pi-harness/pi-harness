import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

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

function workspacePath(workspace: string, requested: string): string {
  const normalized = requested.trim() || defaultFileName;
  if (normalized.length > 256) throw new Error("Session export path must be at most 256 characters");
  const root = resolve(workspace);
  const target = resolve(root, normalized);
  const relativePath = relative(root, target);
  if (relativePath.startsWith("..") || relativePath.includes("/..")) throw new Error("Session export path must stay inside the current workspace");
  if (!relativePath.endsWith(".md")) throw new Error("Session export path must end with .md");
  return target;
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
          const target = workspacePath(context.piHarnessLaunch.cwd, params.path ?? defaultFileName);
          const existing = await stat(target).catch(() => undefined);
          if (existing !== undefined && params.confirm !== true) throw new Error("Session export would overwrite an existing file; retry with confirm=true");
          const markdown = renderSessionMarkdown(runtime.session.messages);
          const bytes = Buffer.byteLength(markdown, "utf8");
          if (bytes > maxOutputBytes) throw new Error("Session export exceeds the 1 MiB output limit");
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, markdown, { encoding: "utf8", mode: 0o600 });
          latest = { path: relative(context.piHarnessLaunch.cwd, target), bytes, messages: runtime.session.messages.length };
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
