import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ProjectTrustStore, SettingsManager, createAgentSessionServices, hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "../config.js";

export interface ResourcesPluginConfig {
  trustProject?: boolean;
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
}

export const Config: z<ResourcesPluginConfig> = z.object({
  trustProject: z.boolean(),
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
    assertKnownConfigKeys("pi-resources", config, ["trustProject", "noExtensions", "noSkills", "noPromptTemplates", "noThemes", "noContextFiles"]);
    const { cwd, agentDir } = context.piHarnessLaunch;
    const storedTrust = new ProjectTrustStore(agentDir).get(cwd);
    const projectTrusted = config.trustProject ?? storedTrust ?? false;
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime: context.piModelRuntime.runtime,
      resourceLoaderOptions: {
        noExtensions: config.noExtensions ?? false,
        noSkills: config.noSkills ?? false,
        noPromptTemplates: config.noPromptTemplates ?? false,
        noThemes: config.noThemes ?? false,
        noContextFiles: config.noContextFiles ?? false,
      },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: () => Promise.resolve(projectTrusted),
      },
    });
    for (const failure of settingsManager.drainErrors()) services.diagnostics.push({ type: "warning", message: `Invalid ${failure.scope} settings file${failure.path === undefined ? "" : ` ${failure.path}`}: ${failure.error.message}` });
    if (!projectTrusted && hasTrustRequiringProjectResources(cwd)) services.diagnostics.push({ type: "warning", message: `Skipped project-local Pi resources under ${cwd} because the project is not trusted; set trustProject: true on the pi-resources entry to load them` });
    const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
    if (errors.length > 0) throw new Error(`Pi resource loading failed:\n${errors.map((diagnostic) => diagnostic.message).join("\n")}`);
    context.provide("piResources", services);
  },
};
