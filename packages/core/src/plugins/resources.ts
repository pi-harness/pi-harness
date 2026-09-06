import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  ProjectTrustStore,
  SettingsManager,
  createAgentSessionServices,
  hasTrustRequiringProjectResources,
  type AgentSessionServices,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "../config.js";
import { configureHttpProxy } from "../http.js";

export interface ResourcesPluginConfig {
  trustProject?: boolean;
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
}

const resourceDiagnosticLimit = 100;
const resourceDiagnosticMessageLimit = 2_048;

export const Config: z<ResourcesPluginConfig> = z.object({
  trustProject: z.boolean(),
  noExtensions: z.boolean().default(false),
  noSkills: z.boolean().default(false),
  noPromptTemplates: z.boolean().default(false),
  noThemes: z.boolean().default(false),
  noContextFiles: z.boolean().default(false),
});

function appendResourceDiagnostics(services: AgentSessionServices): void {
  const extensions = services.resourceLoader.getExtensions();
  for (const failure of extensions.errors)
    services.diagnostics.push({ type: "error", message: `Failed to load extension "${failure.path}": ${failure.error}` });

  const append = (label: string, diagnostics: readonly ResourceDiagnostic[]): void => {
    for (const diagnostic of diagnostics) {
      const location = diagnostic.path === undefined ? "" : ` "${diagnostic.path}"`;
      services.diagnostics.push({
        type: diagnostic.type === "error" ? "error" : "warning",
        message: `${label}${location}: ${diagnostic.message}`,
      });
    }
  };
  append("Skill resource", services.resourceLoader.getSkills().diagnostics);
  append("Prompt resource", services.resourceLoader.getPrompts().diagnostics);
  append("Theme resource", services.resourceLoader.getThemes().diagnostics);
}

function boundedDiagnosticMessage(message: string): string {
  const bounded = message.length <= resourceDiagnosticMessageLimit ? message : `${message.slice(0, resourceDiagnosticMessageLimit - 1)}…`;
  return bounded.replaceAll("\0", "�").replace(/\s+/gu, " ").trim() || "Unknown resource diagnostic";
}

function boundResourceDiagnostics(services: AgentSessionServices): void {
  const normalized = services.diagnostics.map((diagnostic) => ({ ...diagnostic, message: boundedDiagnosticMessage(diagnostic.message) }));
  if (normalized.length <= resourceDiagnosticLimit) {
    services.diagnostics.splice(0, services.diagnostics.length, ...normalized);
    return;
  }

  const retainedLimit = resourceDiagnosticLimit - 1;
  const errors = normalized.filter((diagnostic) => diagnostic.type === "error");
  const nonErrors = normalized.filter((diagnostic) => diagnostic.type !== "error");
  const retained = [...errors, ...nonErrors].slice(0, retainedLimit);
  const retainedErrors = retained.filter((diagnostic) => diagnostic.type === "error").length;
  const omittedErrors = errors.length - retainedErrors;
  const omittedNonErrors = normalized.length - errors.length - (retained.length - retainedErrors);
  const omittedParts = [
    ...(omittedErrors === 0 ? [] : [`${omittedErrors} additional error${omittedErrors === 1 ? "" : "s"}`]),
    ...(omittedNonErrors === 0 ? [] : [`${omittedNonErrors} additional warning${omittedNonErrors === 1 ? "" : "s"}`]),
  ];
  retained.push({
    type: omittedErrors > 0 ? "error" : "warning",
    message: `Resource diagnostics omitted: ${omittedParts.join(", ")}`,
  });
  services.diagnostics.splice(0, services.diagnostics.length, ...retained);
}

export default {
  name: "pi-resources",
  inject: ["piHarnessLaunch", "piModelRuntime"],
  Config,
  async apply(context: Context, config: ResourcesPluginConfig) {
    assertKnownConfigKeys("pi-resources", config, ["trustProject", "noExtensions", "noSkills", "noPromptTemplates", "noThemes", "noContextFiles"]);
    const agentDir = context.piHarnessLaunch.agentDir;
    const trustStore = new ProjectTrustStore(agentDir);
    const resourceLoaderOptions = {
      noExtensions: config.noExtensions ?? false,
      noSkills: config.noSkills ?? false,
      noPromptTemplates: config.noPromptTemplates ?? false,
      noThemes: config.noThemes ?? false,
      noContextFiles: config.noContextFiles ?? false,
    };
    // Project-local .pi resources are executable code owned by whoever wrote the repository, so they
    // load only for a trusted cwd. A non-interactive host cannot ask, so an unrecorded project is untrusted.
    const createServices = async (cwd: string): Promise<AgentSessionServices> => {
      if (!isAbsolute(cwd)) throw new Error(`Pi resource cwd must be an absolute path: ${cwd}`);
      let cwdStats;
      try {
        cwdStats = await stat(cwd);
      } catch (cause) {
        throw new Error(`Pi resource cwd must be an existing directory: ${cwd}`, { cause });
      }
      if (!cwdStats.isDirectory()) throw new Error(`Pi resource cwd must be an existing directory: ${cwd}`);
      const projectTrusted = config.trustProject ?? trustStore.get(cwd) ?? false;
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        modelRuntime: context.piModelRuntime.runtime,
        resourceLoaderOptions,
        resourceLoaderReloadOptions: { resolveProjectTrust: () => Promise.resolve(projectTrusted) },
      });
      appendResourceDiagnostics(services);
      for (const failure of settingsManager.drainErrors())
        services.diagnostics.push({
          type: "warning",
          message: `Invalid ${failure.scope} settings file${failure.path === undefined ? "" : ` ${failure.path}`}: ${failure.error.message}`,
        });
      if (!projectTrusted && hasTrustRequiringProjectResources(cwd))
        services.diagnostics.push({
          type: "warning",
          message: `Skipped project-local Pi resources under ${cwd} because the project is not trusted; set trustProject: true on the pi-resources entry to load them`,
        });
      boundResourceDiagnostics(services);
      const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
      if (errors.length > 0) throw new Error(`Pi resource loading failed:\n${errors.map((diagnostic) => diagnostic.message).join("\n")}`);
      const proxyFailure = await configureHttpProxy(services);
      if (proxyFailure !== undefined) {
        services.diagnostics.push({ type: "warning", message: proxyFailure });
        boundResourceDiagnostics(services);
      }
      return services;
    };
    const services = await createServices(context.piHarnessLaunch.cwd);
    context.provide("piResources", { ...services, createForCwd: createServices });
  },
};
