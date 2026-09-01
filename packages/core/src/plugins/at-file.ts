import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxBytes = 256 * 1024;

function resolveWorkspaceFile(workspace: string, requested: string): string {
  const root = resolve(workspace);
  const target = resolve(root, requested);
  const path = relative(root, target);
  if (path.startsWith("..") || path.includes("/..")) throw new Error("File path must stay inside the current workspace");
  return target;
}

export default {
  name: "pi-at-file",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let lastFile: { path: string; bytes: number } | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "file_context",
        label: "File context",
        description: "Attach a text file from the current workspace to the model context with a bounded size.",
        promptSnippet: "attach a workspace file to the current context",
        parameters: Type.Object({ path: Type.String({ description: "File path relative to the workspace" }) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ path: string; bytes: number }>> {
          const target = resolveWorkspaceFile(context.piHarnessLaunch.cwd, params.path);
          const metadata = await stat(target);
          if (!metadata.isFile()) throw new Error("Context path is not a file");
          if (metadata.size > maxBytes) throw new Error("Context file exceeds the 256 KiB attachment limit");
          const path = relative(context.piHarnessLaunch.cwd, target) || ".";
          const text = await readFile(target, "utf8");
          lastFile = { path, bytes: metadata.size };
          return { content: [{ type: "text", text: `<file path="${path}">\n${text}\n</file>` }], details: lastFile };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "at-file-panel",
      pluginId: "@pi-harness/core/plugins/at-file",
      title: "@file 上下文",
      description: "将工作区内的文本文件安全附加到当前对话。",
      icon: "⌁",
      read: () => ({ lastFile: lastFile ?? null, maxBytes }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
