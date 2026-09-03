import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const capsuleDirectory = "capsules";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

export async function applyCapsule(cwd: string, capsulePath: string): Promise<void> {
  try {
    await git(cwd, ["apply", "--reverse", "--check", "--binary", capsulePath]);
  } catch (cause) {
    throw new Error("Git capsule does not apply cleanly", { cause });
  }
  await git(cwd, ["apply", "--reverse", "--binary", capsulePath]);
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
    let latest: { name: string; bytes: number; files: number; restored?: boolean } | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "git_snapshot",
        label: "Git snapshot",
        description: "Save the current tracked Git diff as a timestamped patch outside the workspace for rollback or review.",
        promptSnippet: "save a rollback patch before changing code",
        parameters: Type.Object({}),
        async execute(): Promise<AgentToolResult<{ path: string; bytes: number; files: number }>> {
          const status = await git(context.piHarnessLaunch.cwd, ["status", "--short"]);
          const patch = await git(context.piHarnessLaunch.cwd, ["diff", "HEAD", "--binary", "--no-ext-diff", "--", ".", ":(exclude).pi-harness/capsules"]);
          await mkdir(directory, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
          const name = `${timestamp}-${randomUUID().slice(0, 8)}.patch`;
          const path = join(directory, name);
          await writeFile(path, patch, { encoding: "utf8", mode: 0o600, flag: "wx" });
          const files = status.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("??")).length;
          latest = { name, bytes: Buffer.byteLength(patch), files };
          return { content: [{ type: "text", text: `Git snapshot saved: ${name}` }], details: { path, bytes: latest.bytes, files } };
        },
      }),
    );
    const unregisterRestore = context.piTools.register(
      defineTool({
        name: "git_restore",
        label: "Restore Git snapshot",
        description: "Apply a saved Git time capsule after an explicit confirmation; the patch is checked before it changes the workspace.",
        promptSnippet: "restore a previously saved Git snapshot",
        parameters: Type.Object({ name: Type.String({ description: "Capsule filename from the recent snapshots list" }), confirm: Type.Boolean() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ name: string; restored: true }>> {
          if (!params.confirm) throw new Error("Git capsule restore writes the workspace and requires confirm=true");
          const name = params.name.trim();
          if (name.length === 0 || name.length > 255 || basename(name) !== name || !name.endsWith(".patch"))
            throw new Error("Capsule name must be a .patch filename");
          const path = join(directory, name);
          await applyCapsule(context.piHarnessLaunch.cwd, path);
          const bytes = (await stat(path)).size;
          latest = { name, bytes, files: 0, restored: true };
          return { content: [{ type: "text", text: `Git snapshot restored: ${name}` }], details: { name, restored: true } };
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
      unregisterRestore();
      disposePanel();
    });
  },
};
