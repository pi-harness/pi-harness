import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, test } from "vitest";
import { provideLaunchContext } from "../src/services.js";
import resourcesPlugin from "../src/plugins/resources.js";
import runtimePlugin from "../src/plugins/runtime.js";
import sessionPlugin from "../src/plugins/session.js";
import toolsPlugin from "../src/plugins/tools.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createRuntimeContext(): Promise<{ context: Context; responseText: string[]; callCount: () => number }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-runtime-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-runtime-agent-"));
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  const faux = fauxProvider({ provider: "pi-harness-test", models: [{ id: "deterministic" }] });
  faux.setResponses([fauxAssistantMessage("deterministic response")]);
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("pi-harness-test", "deterministic");
  if (model === undefined) throw new Error("Faux model registration failed");
  context.provide("piModels", { runtime: modelRuntime, model });
  await context.plugin(resourcesPlugin, { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await context.plugin(sessionPlugin, { storage: "memory" });
  await context.plugin(toolsPlugin, { names: [] });
  await context.plugin(runtimePlugin, { thinkingLevel: "off" });
  const responseText: string[] = [];
  context.piRuntime.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") responseText.push(event.assistantMessageEvent.delta);
  });
  return { context, responseText, callCount: () => faux.state.callCount };
}

describe("Pi runtime plugin", () => {
  test("completes a deterministic Pi agent run", async () => {
    const { context, responseText, callCount } = await createRuntimeContext();

    await context.piRuntime.prompt("respond once");

    expect(responseText.join("")).toBe("deterministic response");
    expect(callCount()).toBe(1);
  });

  test("disposes the Pi session with its Cordis fiber", async () => {
    const { context } = await createRuntimeContext();
    const runtime = context.piRuntime;

    await context.fiber.dispose();

    await expect(runtime.prompt("too late")).rejects.toThrow(/disposed/);
  });
});
