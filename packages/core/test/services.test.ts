import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "../src/services.js";
import modelPlugin from "../src/plugins/model.js";
import modelsPlugin from "../src/plugins/models.js";
import resourcesPlugin from "../src/plugins/resources.js";
import sessionPlugin from "../src/plugins/session.js";
import toolsPlugin from "../src/plugins/tools.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createContext(): Promise<{ context: Context; cwd: string; agentDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-agent-"));
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  return { context, cwd, agentDir };
}

const modelConfig = { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: false } as const;
const isolatedResources = { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } as const;

describe("Pi domain plugins", () => {
  test("fails activation when the selected model does not exist", async () => {
    const { context } = await createContext();

    await context.plugin(modelsPlugin, { provider: "missing-provider", model: "missing-model", refreshOnCreate: false });
    await context.plugin(resourcesPlugin, isolatedResources);

    await expect(context.plugin(modelPlugin)).rejects.toThrow(/missing-provider\/missing-model/);
  });

  test("activates a pending resources plugin after its models dependency", async () => {
    const { context, cwd } = await createContext();
    const pendingResources = context.plugin(resourcesPlugin, isolatedResources);

    await context.plugin(modelsPlugin, modelConfig);
    await pendingResources;

    expect(context.get("piResources")?.cwd).toBe(cwd);
    expect(context.get("piResources")?.modelRuntime).toBe(context.get("piModelRuntime")?.runtime);
  });

  test("isolates Pi model files under the configured agent directory", async () => {
    const { context, agentDir } = await createContext();

    await context.plugin(modelsPlugin, modelConfig);

    const runtime = context.piModelRuntime.runtime as unknown as { modelsPath: string };
    expect(runtime.modelsPath).toBe(join(agentDir, "models.json"));
  });

  test("selects models registered by Pi extensions after resource loading", async () => {
    const { context, agentDir } = await createContext();
    const extensionsDir = join(agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      join(extensionsDir, "provider.ts"),
      `export default function (pi) { pi.registerProvider("extension-provider", { baseUrl: "https://example.invalid", apiKey: "test-key", api: "openai-completions", models: [{ id: "extension-model", name: "Extension Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }] }); }`,
      "utf8",
    );

    await context.plugin(modelsPlugin, { provider: "extension-provider", model: "extension-model", refreshOnCreate: false });
    await context.plugin(resourcesPlugin, { ...isolatedResources, noExtensions: false });
    await context.plugin(modelPlugin);

    expect(context.piModels.model.id).toBe("extension-model");
    expect(context.piModels.model.provider).toBe("extension-provider");
  });

  test("creates an in-memory session when configured", async () => {
    const { context } = await createContext();

    await context.plugin(sessionPlugin, { storage: "memory" });

    expect(context.get("piSession")?.manager.isPersisted()).toBe(false);
  });

  test("creates a JSONL session in the configured directory", async () => {
    const { context } = await createContext();
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-sessions-"));

    await context.plugin(sessionPlugin, { storage: "jsonl", directory });

    expect(context.get("piSession")?.manager.isPersisted()).toBe(true);
    expect(context.get("piSession")?.manager.getSessionDir()).toBe(directory);
  });

  test("keeps the default JSONL session under the configured agent directory", async () => {
    const { context, agentDir } = await createContext();

    await context.plugin(sessionPlugin, { storage: "jsonl" });

    expect(context.get("piSession")?.manager.getSessionDir()).toBe(join(agentDir, "sessions"));
  });

  test("contributes Pi's core tools through a lifecycle-owned registry", async () => {
    const { context } = await createContext();

    await context.plugin(toolsPlugin, { names: ["read", "bash", "edit", "write"] });

    expect(context.get("piTools")?.snapshot()).toEqual({ names: ["read", "bash", "edit", "write"], customTools: [] });
  });

  test("rejects tool contributions while runtime owns a snapshot and accepts them after release", () => {
    const tools = new PiToolRegistry();
    const lateTool = defineTool({
      name: "late",
      label: "Late",
      description: "A tool registered after runtime startup.",
      parameters: Type.Object({}),
      execute() {
        return Promise.resolve({ content: [{ type: "text", text: "late" }], details: undefined });
      },
    });

    const lease = tools.acquire();
    expect(lease.names).toEqual([]);
    expect(lease.customTools).toEqual([]);
    expect(() => tools.register(lateTool)).toThrow(/leased/);

    lease.release();
    expect(() => tools.register(lateTool)).not.toThrow();
  });

  test("registers and disposes plugin UI panels with the plugin lifecycle", async () => {
    const panels = new PiPluginUiRegistry();
    const dispose = panels.register({
      id: "example-panel",
      pluginId: "example-plugin",
      title: "Example",
      read: () => ({ ready: true }),
    });

    await expect(panels.snapshot()).resolves.toEqual([{ id: "example-panel", pluginId: "example-plugin", title: "Example", data: { ready: true } }]);
    dispose();
    await expect(panels.snapshot()).resolves.toEqual([]);
  });
});
