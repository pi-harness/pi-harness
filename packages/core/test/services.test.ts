import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { provideLaunchContext } from "../src/services.js";
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

    await expect(context.plugin(modelsPlugin, { provider: "missing-provider", model: "missing-model", refreshOnCreate: false })).rejects.toThrow(/missing-provider\/missing-model/);
  });

  test("activates a pending resources plugin after its models dependency", async () => {
    const { context, cwd } = await createContext();
    const pendingResources = context.plugin(resourcesPlugin, isolatedResources);

    await context.plugin(modelsPlugin, modelConfig);
    await pendingResources;

    expect(context.get("piResources")?.cwd).toBe(cwd);
    expect(context.get("piResources")?.modelRuntime).toBe(context.get("piModels")?.runtime);
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

  test("contributes Pi's core tools through a lifecycle-owned registry", async () => {
    const { context } = await createContext();

    await context.plugin(toolsPlugin, { names: ["read", "bash", "edit", "write"] });

    expect(context.get("piTools")?.snapshot()).toEqual({ names: ["read", "bash", "edit", "write"], customTools: [] });
  });
});
