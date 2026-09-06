import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import modelsPlugin, { Config as ModelsConfig } from "../src/plugins/models.js";
import { provideLaunchContext } from "../src/services.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createContext(): Promise<{ context: Context; agentDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-models-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-models-agent-"));
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  return { context, agentDir };
}

describe("models plugin", () => {
  test.each([
    [{ provider: "   ", model: "deepseek-v4-flash" }, /provider/u],
    [{ provider: "deep\nseek", model: "deepseek-v4-flash" }, /provider/u],
    [{ provider: "p".repeat(129), model: "deepseek-v4-flash" }, /provider/u],
    [{ provider: "deepseek", model: "\t" }, /model/u],
    [{ provider: "deepseek", model: "bad\0model" }, /model/u],
    [{ provider: "deepseek", model: "m".repeat(513) }, /model/u],
  ])("rejects an unsafe or unbounded model selection %#", (config, expected) => {
    expect(() => ModelsConfig(config)).toThrow(expected);
  });

  test("fails activation instead of silently ignoring an invalid models file", async () => {
    const { context, agentDir } = await createContext();
    await writeFile(join(agentDir, "models.json"), "{ not-json", "utf8");

    let activationError: unknown;
    try {
      await context.plugin(modelsPlugin, { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: false });
    } catch (error) {
      activationError = error;
    }

    expect(activationError).toBeInstanceOf(Error);
    expect((activationError as Error).message).toMatch(/Failed to parse models\.json/u);
    expect(context.get("piModelRuntime")).toBeUndefined();
  });

  test("rejects unknown configuration without publishing a partial service", async () => {
    const { context } = await createContext();

    await expect(
      context.plugin(modelsPlugin, { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: false, refreshOnCreat: true } as never),
    ).rejects.toThrow(/Unknown pi-models config keys: refreshOnCreat/u);
    expect(context.get("piModelRuntime")).toBeUndefined();
  });

  test("removes the model runtime service on plugin disposal", async () => {
    const { context } = await createContext();
    await context.plugin(modelsPlugin, { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: false });

    expect(context.get("piModelRuntime")?.provider).toBe("deepseek");
    await context.fiber.dispose();

    expect(context.get("piModelRuntime")).toBeUndefined();
  });

  test("bounds opt-in network refresh during startup", async () => {
    const { context } = await createContext();
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
    try {
      await context.plugin(modelsPlugin, { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: true });

      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]?.[0]?.modelRefreshTimeoutMs).toBe(15_000);
    } finally {
      create.mockRestore();
    }
  });
});
