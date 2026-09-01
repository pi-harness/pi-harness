import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const capsuleDirectory = "capsules";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

async function listCapsules(directory: string): Promise<{ name: string; bytes: number }[]> {
  const names = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .reverse()
    .slice(0, 20);
  return Promise.all(names.map(async (name) => ({ name, bytes: (await stat(join(directory, name))).size })));
}

export default {
  name: "pi-git-time-capsule",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    const directory = join(context.piHarnessLaunch.agentDir, capsuleDirectory);
    let latest: { name: string; bytes: number; files: number } | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "git_snapshot",
        label: "Git snapshot",
        description: "Save the current tracked Git diff as a timestamped patch outside the workspace for rollback or review.",
        promptSnippet: "save a rollback patch before changing code",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params): Promise<AgentToolResult<{ path: string; bytes: number; files: number }>> {
          const status = await git(context.piHarnessLaunch.cwd, ["status", "--short"]);
          const patch = await git(context.piHarnessLaunch.cwd, ["diff", "HEAD", "--binary", "--no-ext-diff", "--", ".", ":(exclude).pi-harness/capsules"]);
          await mkdir(directory, { recursive: true });
          const timestamp = new Date()
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(/\.\d{3}Z$/, "Z");
          const name = `${timestamp}.patch`;
          const path = join(directory, name);
          await writeFile(path, patch, "utf8");
          const files = status.split("\n").filter((line) => line.trim() !== "").length;
          latest = { name, bytes: Buffer.byteLength(patch), files };
          return { content: [{ type: "text", text: `Git snapshot saved: ${name}` }], details: { path, bytes: latest.bytes, files } };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "git-time-capsule-panel",
      pluginId: "@pi-harness/core/plugins/git-time-capsule",
      title: "Git Time Capsule",
      description: "查看最近的代码快照；快照保存在工作区之外，不会污染项目文件。",
      icon: "◫",
      read: async () => ({ latest: latest ?? null, capsules: await listCapsules(directory) }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
