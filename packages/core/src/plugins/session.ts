import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

export interface SessionPluginConfig {
  storage?: "memory" | "jsonl";
  directory?: string;
}

const maxSessionDirectoryLength = 4_096;
const sessionDirectoryPattern = /^(?=[\s\S]*\S)\P{Cc}+$/u;

export const Config: z<SessionPluginConfig> = z.object({
  storage: z.union(["memory", "jsonl"]).default("jsonl"),
  directory: z.string().min(1).max(maxSessionDirectoryLength).pattern(sessionDirectoryPattern),
});

export default {
  name: "pi-session",
  inject: ["piHarnessLaunch"],
  Config,
  apply(context: Context, config: SessionPluginConfig) {
    assertKnownConfigKeys("pi-session", config, ["storage", "directory"]);
    const storage = config.storage ?? "jsonl";
    if (storage === "memory" && config.directory != null) throw new Error("Pi session directory cannot be configured with memory storage");
    const manager =
      storage === "memory"
        ? SessionManager.inMemory(context.piHarnessLaunch.cwd)
        : SessionManager.create(
            context.piHarnessLaunch.cwd,
            config.directory == null ? join(context.piHarnessLaunch.agentDir, "sessions") : resolve(context.piHarnessLaunch.cwd, config.directory),
          );
    if (storage === "jsonl" && !statSync(manager.getSessionDir()).isDirectory())
      throw new Error(`Pi session directory must be a directory: ${manager.getSessionDir()}`);
    context.provide("piSession", { manager });
  },
};
