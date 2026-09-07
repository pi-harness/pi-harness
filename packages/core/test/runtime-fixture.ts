import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { provideLaunchContext } from "@pi-harness/plugin-api";
import resourcesPlugin from "../src/plugins/resources.js";
import runtimePlugin from "../src/plugins/runtime.js";
import sessionPlugin from "../src/plugins/session.js";
import toolsPlugin from "../src/plugins/tools.js";

export async function createTestRuntimeServices(
  responses: FauxResponseStep[],
  toolNames: string[] = [],
  resourceOptions: { noExtensions: boolean; agentDir?: string } = { noExtensions: true },
): Promise<{ context: Context; faux: FauxProviderHandle }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-runtime-"));
  const agentDir = resourceOptions.agentDir ?? (await mkdtemp(join(tmpdir(), "pi-harness-runtime-agent-")));
  const context = new Context();
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    modelsPath: null,
    authPath: join(agentDir, "auth.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
  });
  const faux = fauxProvider({ provider: "pi-harness-test", models: [{ id: "deterministic" }] });
  faux.setResponses(responses);
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("pi-harness-test", "deterministic");
  if (model === undefined) throw new Error("Faux model registration failed");
  context.provide("piModelRuntime", { runtime: modelRuntime, provider: "pi-harness-test", model: "deterministic" });
  await context.plugin(resourcesPlugin, {
    noExtensions: resourceOptions.noExtensions,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  context.provide("piModels", { runtime: modelRuntime, model });
  await context.plugin(sessionPlugin, { storage: "memory" });
  await context.plugin(toolsPlugin, { names: toolNames });
  return { context, faux };
}

export async function createTestRuntimeContext(
  responses: FauxResponseStep[],
  toolNames: string[] = [],
  resourceOptions: { noExtensions: boolean; agentDir?: string } = { noExtensions: true },
): Promise<{ context: Context; faux: FauxProviderHandle }> {
  const { context, faux } = await createTestRuntimeServices(responses, toolNames, resourceOptions);
  await context.plugin(runtimePlugin, { thinkingLevel: "off" });
  return { context, faux };
}
