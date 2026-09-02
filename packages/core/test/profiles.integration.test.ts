import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { bootHarness, type BootedHarness } from "../src/boot.js";
import { resolveProfileConfig } from "../src/profile.js";
import { provideLaunchContext } from "../src/services.js";
import { provideStdioContext } from "../src/stdio.js";

const booted: BootedHarness[] = [];

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (harness) => harness.dispose()));
});

async function bootProfile(profile: string): Promise<{ harness: BootedHarness; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-profile-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-profile-agent-"));
  const configPath = await resolveProfileConfig({ profile });
  const harness = await bootHarness({
    configPath,
    prepare(context) {
      provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
      provideStdioContext(context, {
        readPrompt() {
          return Promise.resolve("");
        },
        writeOutput() {},
        writeError() {},
      });
    },
  });
  booted.push(harness);
  return { harness, cwd };
}

describe("packaged profiles", () => {
  test("boots the default production profile without HMR", async () => {
    const { harness } = await bootProfile("default");
    const names = [...harness.context.loader.entries()].map((entry) => entry.options.name);

    expect(harness.context.get("piModels")?.model.provider).toBe("deepseek");
    expect(harness.context.get("piApplication")).toBeDefined();
    expect(harness.context.get("hmr")).toBeUndefined();
    expect(names).not.toContain("@deepseek-ai/cordis-plugin-hmr");
    expect(names).toContain("@pi-harness/core/plugins/vision-toolkit");
    expect(names).toContain("@pi-harness/core/plugins/plugin-stars");
    expect(names).toContain("@pi-harness/core/plugins/session-bridge");
    expect(names).toContain("@pi-harness/core/plugins/skill-guard");
    expect(names).toContain("@pi-harness/core/plugins/recall-unread");
  });

  test("boots the development profile with logger, timer, and HMR plugins", async () => {
    const { harness, cwd } = await bootProfile("development");
    const entries = [...harness.context.loader.entries()];
    const names = entries.map((entry) => entry.options.name);
    const timer = entries.find((entry) => entry.options.name === "@deepseek-ai/cordis-plugin-timer");
    const hmr = entries.find((entry) => entry.options.name === "@deepseek-ai/cordis-plugin-hmr");

    expect(timer?.fiber?.ctx.get("timer")).toBeDefined();
    expect(hmr?.fiber?.ctx.get("hmr")).toMatchObject({ baseDir: cwd });
    expect(names).toEqual(
      expect.arrayContaining(["@deepseek-ai/cordis-plugin-logger-console", "@deepseek-ai/cordis-plugin-timer", "@deepseek-ai/cordis-plugin-hmr"]),
    );
  });

  test("activates an external tool plugin before the runtime through Cordis injection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-custom-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-custom-agent-"));
    const configPath = join(cwd, "cordis.yml");
    const plugins = {
      models: import.meta.resolve("@pi-harness/core/plugins/models"),
      resources: import.meta.resolve("@pi-harness/core/plugins/resources"),
      model: import.meta.resolve("@pi-harness/core/plugins/model"),
      session: import.meta.resolve("@pi-harness/core/plugins/session"),
      tools: import.meta.resolve("@pi-harness/core/plugins/tools"),
      hello: import.meta.resolve("@pi-harness/plugin-hello"),
      runtime: import.meta.resolve("@pi-harness/core/plugins/runtime"),
      stdio: import.meta.resolve("@pi-harness/core/plugins/stdio"),
    };
    await writeFile(
      configPath,
      JSON.stringify([
        { id: "models", name: plugins.models, config: { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: false } },
        {
          id: "resources",
          name: plugins.resources,
          config: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
        },
        { id: "model", name: plugins.model, config: {} },
        { id: "session", name: plugins.session, config: { storage: "memory" } },
        { id: "tools", name: plugins.tools, config: { names: [] } },
        { id: "hello", name: plugins.hello, config: {} },
        { id: "runtime", name: plugins.runtime, inject: ["piHelloTool"], config: { thinkingLevel: "medium" } },
        { id: "stdio", name: plugins.stdio, config: {} },
      ]),
      "utf8",
    );
    const harness = await bootHarness({
      configPath,
      prepare(context) {
        provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
        provideStdioContext(context, {
          readPrompt() {
            return Promise.resolve("");
          },
          writeOutput() {},
          writeError() {},
        });
      },
    });
    booted.push(harness);

    expect(
      harness.context
        .get("piTools")
        ?.snapshot()
        .customTools.map((tool) => tool.name),
    ).toEqual(["hello"]);
    const sessionTools = harness.context.get("piRuntime")?.session.getAllTools();
    expect(sessionTools).toHaveLength(1);
    expect(sessionTools?.[0]?.name).toBe("hello");
    expect(sessionTools?.[0]?.sourceInfo.source).toBe("sdk");
  });
});
