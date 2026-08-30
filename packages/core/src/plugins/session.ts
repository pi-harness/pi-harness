import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface SessionPluginConfig {
  storage?: "memory" | "jsonl";
  directory?: string;
}

export const Config: z<SessionPluginConfig> = z.object({
  storage: z.union(["memory", "jsonl"]).default("jsonl"),
  directory: z.string(),
});

export default {
  name: "pi-session",
  inject: ["piHarnessLaunch"],
  Config,
  apply(context: Context, config: SessionPluginConfig) {
    const storage = config.storage ?? "jsonl";
    const manager = storage === "memory"
      ? SessionManager.inMemory(context.piHarnessLaunch.cwd)
      : SessionManager.create(context.piHarnessLaunch.cwd, config.directory === undefined ? undefined : resolve(context.piHarnessLaunch.cwd, config.directory));
    context.provide("piSession", { manager });
  },
};
