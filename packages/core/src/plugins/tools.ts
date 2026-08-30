import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { PiToolRegistry } from "../services.js";

export interface ToolsPluginConfig {
  names?: string[];
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export const Config: z<ToolsPluginConfig> = z.object({
  names: z.array(z.string()).default(DEFAULT_TOOLS),
});

export default {
  name: "pi-tools",
  Config,
  apply(context: Context, config: ToolsPluginConfig) {
    const names = config.names ?? DEFAULT_TOOLS;
    if (new Set(names).size !== names.length) throw new Error("Pi core tool names must be unique");
    context.provide("piTools", new PiToolRegistry(names));
  },
};
