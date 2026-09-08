import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile, prepareWorkspaceFile } from "@pi-harness/plugin-api";

const maxContentBytes = 512 * 1024;
const maxRelativePathLength = 512;
type SyncResult = { relativePath: string; absolutePath: string; bytes: number };

export interface ObsidianSyncPluginConfig {
  vaultPath?: string;
}

export const Config: z<ObsidianSyncPluginConfig> = z.object({ vaultPath: z.string().default("") });

export default {
  name: "pi-obsidian-sync",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ObsidianSyncPluginConfig) {
    const configuredVault = config.vaultPath?.trim() ?? "";
    const lifecycle = new AbortController();
    let operations = Promise.resolve();
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = operations.then(operation);
      operations = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    context.effect(() => async () => {
      lifecycle.abort(new Error("Obsidian sync plugin disposed"));
      await operations;
    });
    let last: SyncResult | undefined;
    const sync = async (relativePath: string, content: string, confirm: boolean, signal: AbortSignal): Promise<SyncResult> => {
      signal.throwIfAborted();
      if (configuredVault === "") throw new Error("Obsidian sync requires vaultPath in the plugin configuration");
      if (!confirm) throw new Error("Obsidian sync requires confirm=true before writing a note");
      if (
        isAbsolute(relativePath) ||
        win32.isAbsolute(relativePath) ||
        relativePath.includes("\\") ||
        relativePath.length === 0 ||
        relativePath.length > maxRelativePathLength ||
        !relativePath.toLowerCase().endsWith(".md")
      )
        throw new Error("Obsidian note path must be a relative .md path of at most 512 characters");
      if (content.length === 0 || Buffer.byteLength(content, "utf8") > maxContentBytes)
        throw new Error(`Obsidian note content must be between 1 and ${maxContentBytes} bytes`);
      const configuredRoot = resolve(context.piHarnessLaunch.cwd, configuredVault);
      await mkdir(configuredRoot, { recursive: true });
      signal.throwIfAborted();
      const { target } = await prepareWorkspaceFile(
        configuredRoot,
        relativePath,
        "Obsidian note path must stay inside the configured vault and target a regular file",
      );
      signal.throwIfAborted();
      // No explicit mode: a vault note is a user document, so replacing one keeps whatever bits the user gave it and only a note this creates falls back to atomicWriteFile's owner-only default.
      await atomicWriteFile(target, content, { encoding: "utf8", signal });
      last = { relativePath, absolutePath: target, bytes: Buffer.byteLength(content, "utf8") };
      return { ...last };
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
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SyncResult>> {
          const executionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const result = await enqueue(() => sync(params.relativePath, params.content, params.confirm, executionSignal));
          return { content: [{ type: "text", text: `Obsidian note written: ${result.relativePath}` }], details: result };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "obsidian-sync-panel",
        pluginId: "@pi-harness/plugin-obsidian-sync",
        title: "Obsidian Sync",
        description: "将 Agent 产出的 Markdown 安全写入指定 Obsidian vault。",
        icon: "▤",
        read: () => ({ configured: configuredVault !== "", vaultPath: configuredVault || null, last: last === undefined ? null : { ...last } }),
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
