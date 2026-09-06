import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "../atomic-write.js";

const maxContentBytes = 512 * 1024;
const maxRelativePathLength = 512;
type SyncResult = { relativePath: string; absolutePath: string; bytes: number };

export interface ObsidianSyncPluginConfig {
  vaultPath?: string;
}

export const Config: z<ObsidianSyncPluginConfig> = z.object({ vaultPath: z.string().default("") });

function isInside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${"/"}`) && !remainder.startsWith(`..${"\\"}`) && !remainder.startsWith("/"));
}

export default {
  name: "pi-obsidian-sync",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ObsidianSyncPluginConfig) {
    const configuredVault = config.vaultPath?.trim() ?? "";
    let last: SyncResult | undefined;
    const sync = async (relativePath: string, content: string, confirm: boolean): Promise<SyncResult> => {
      if (configuredVault === "") throw new Error("Obsidian sync requires vaultPath in the plugin configuration");
      if (!confirm) throw new Error("Obsidian sync requires confirm=true before writing a note");
      if (relativePath.length === 0 || relativePath.length > maxRelativePathLength || !relativePath.toLowerCase().endsWith(".md"))
        throw new Error("Obsidian note path must be a relative .md path of at most 512 characters");
      if (content.length === 0 || Buffer.byteLength(content, "utf8") > maxContentBytes)
        throw new Error(`Obsidian note content must be between 1 and ${maxContentBytes} bytes`);
      await mkdir(configuredVault, { recursive: true });
      const vault = await realpath(configuredVault);
      const target = resolve(vault, relativePath);
      if (!isInside(vault, target)) throw new Error("Obsidian note path must stay inside the configured vault");
      const parent = dirname(target);
      await mkdir(parent, { recursive: true });
      if (!isInside(vault, await realpath(parent))) throw new Error("Obsidian note path must stay inside the configured vault");
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new Error("Obsidian note target cannot be a symbolic link");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicWriteFile(target, content, { encoding: "utf8", mode: 0o600 });
      last = { relativePath, absolutePath: target, bytes: Buffer.byteLength(content, "utf8") };
      return last;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "obsidian_sync",
        label: "Obsidian sync",
        description: "Write a confirmed Markdown note inside the configured Obsidian vault.",
        promptSnippet: "save this result as a Markdown note in the Obsidian vault",
        parameters: Type.Object(
          {
            relativePath: Type.String({ description: "Relative .md path inside the configured vault" }),
            content: Type.String({ description: "Markdown note content" }),
            confirm: Type.Boolean({ description: "Must be true to write the note" }),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<SyncResult>> {
          const result = await sync(params.relativePath, params.content, params.confirm);
          return { content: [{ type: "text", text: `Obsidian note written: ${result.relativePath}` }], details: result };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "obsidian-sync-panel",
        pluginId: "@pi-harness/core/plugins/obsidian-sync",
        title: "Obsidian Sync",
        description: "将 Agent 产出的 Markdown 安全写入指定 Obsidian vault。",
        icon: "▤",
        read: () => ({ configured: configuredVault !== "", vaultPath: configuredVault || null, last: last ?? null }),
      });
    } catch (error) {
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
