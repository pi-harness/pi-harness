import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";

export interface ResourcesPluginConfig {
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
}

export const Config: z<ResourcesPluginConfig> = z.object({
  noExtensions: z.boolean().default(false),
  noSkills: z.boolean().default(false),
  noPromptTemplates: z.boolean().default(false),
  noThemes: z.boolean().default(false),
  noContextFiles: z.boolean().default(false),
});

export default {
  name: "pi-resources",
  inject: ["piHarnessLaunch", "piModelRuntime"],
  Config,
  async apply(context: Context, config: ResourcesPluginConfig) {
    const services = await createAgentSessionServices({
      cwd: context.piHarnessLaunch.cwd,
      agentDir: context.piHarnessLaunch.agentDir,
      modelRuntime: context.piModelRuntime.runtime,
      resourceLoaderOptions: {
        noExtensions: config.noExtensions ?? false,
        noSkills: config.noSkills ?? false,
        noPromptTemplates: config.noPromptTemplates ?? false,
        noThemes: config.noThemes ?? false,
        noContextFiles: config.noContextFiles ?? false,
      },
    });
    const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
    if (errors.length > 0) throw new Error(`Pi resource loading failed:\n${errors.map((diagnostic) => diagnostic.message).join("\n")}`);
    const resourceLoaderOptions = {
      noExtensions: config.noExtensions ?? false,
      noSkills: config.noSkills ?? false,
      noPromptTemplates: config.noPromptTemplates ?? false,
      noThemes: config.noThemes ?? false,
      noContextFiles: config.noContextFiles ?? false,
    };
    context.provide("piResources", {
      ...services,
      createForCwd: (cwd: string) => createAgentSessionServices({
        cwd,
        agentDir: context.piHarnessLaunch.agentDir,
        modelRuntime: context.piModelRuntime.runtime,
        resourceLoaderOptions,
      }),
    });
  },
};
