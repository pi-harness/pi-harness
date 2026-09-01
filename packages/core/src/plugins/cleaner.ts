import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const capsuleDirectory = "capsules";
type Capsule = { name: string; bytes: number };

async function listCapsules(directory: string): Promise<Capsule[]> {
  const names = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .reverse();
  return Promise.all(names.map(async (name) => ({ name, bytes: (await stat(join(directory, name))).size })));
}

export default {
  name: "pi-cleaner",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    const directory = join(context.piHarnessLaunch.agentDir, capsuleDirectory);
    let lastRemoved = 0;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "clean_harness_artifacts",
        label: "Clean harness artifacts",
        description: "Remove only Pi Harness Git capsule patch files from the agent data directory. Confirmation is required.",
        promptSnippet: "clean old Pi Harness rollback artifacts",
        parameters: Type.Object({
          confirm: Type.Boolean({ description: "Must be true to remove files" }),
          keep: Type.Optional(Type.Number({ description: "Number of newest capsules to keep" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ removed: number; kept: number }>> {
          if (params.confirm !== true) throw new Error("Cleaning requires confirm=true");
          const keep = Math.max(0, Math.trunc(params.keep ?? 5));
          const capsules = await listCapsules(directory);
          const remove = capsules.slice(keep);
          await Promise.all(remove.map((capsule) => unlink(join(directory, capsule.name))));
          lastRemoved = remove.length;
          return {
            content: [{ type: "text", text: `Removed ${remove.length} Pi Harness capsule(s); kept ${capsules.length - remove.length}.` }],
            details: { removed: remove.length, kept: capsules.length - remove.length },
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "cleaner-panel",
      pluginId: "@pi-harness/core/plugins/cleaner",
      title: "Harness Cleaner",
      description: "清理 Pi Harness 自己生成的 Git 快照；默认不会触碰项目文件。",
      icon: "⌫",
      read: async () => ({ directory, capsules: await listCapsules(directory), lastRemoved }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
