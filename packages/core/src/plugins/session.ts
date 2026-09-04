import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "../config.js";

export interface SessionPluginConfig {
  storage?: "memory" | "jsonl";
  directory?: string;
}

export const Config: z<SessionPluginConfig> = z.object({
  storage: z.union(["memory", "jsonl"]).default("jsonl"),
  directory: z.string().min(1),
});

export default {
  name: "pi-session",
  inject: ["piHarnessLaunch"],
  Config,
  apply(context: Context, config: SessionPluginConfig) {
    assertKnownConfigKeys("pi-session", config, ["storage", "directory"]);
    const storage = config.storage ?? "jsonl";
    const manager =
      storage === "memory"
        ? SessionManager.inMemory(context.piHarnessLaunch.cwd)
        : SessionManager.create(
            context.piHarnessLaunch.cwd,
            config.directory == null ? join(context.piHarnessLaunch.agentDir, "sessions") : resolve(context.piHarnessLaunch.cwd, config.directory),
          );
    context.provide("piSession", { manager });
  },
};
