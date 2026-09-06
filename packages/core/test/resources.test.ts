import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import modelsPlugin from "../src/plugins/models.js";
import resourcesPlugin, { Config as ResourcesConfig } from "../src/plugins/resources.js";
import { provideLaunchContext } from "../src/services.js";

const contexts: Context[] = [];
const isolatedResources = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const;

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createContext(): Promise<{ context: Context; cwd: string; agentDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-resources-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-resources-agent-"));
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  await context.plugin(modelsPlugin, { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: false });
  return { context, cwd, agentDir };
}

async function createProjectResources(cwd: string, marker: string): Promise<void> {
  await Promise.all([
    mkdir(join(cwd, ".pi", "extensions"), { recursive: true }),
    mkdir(join(cwd, ".pi", "skills", "resource-probe"), { recursive: true }),
    mkdir(join(cwd, ".pi", "prompts"), { recursive: true }),
    mkdir(join(cwd, ".pi", "themes"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(cwd, ".pi", "extensions", "probe.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export default function () {}`,
      "utf8",
    ),
    writeFile(
      join(cwd, ".pi", "skills", "resource-probe", "SKILL.md"),
      "---\nname: resource-probe\ndescription: Verify resource loading\n---\n\n# Resource Probe\n",
      "utf8",
    ),
    writeFile(join(cwd, ".pi", "prompts", "resource-probe.md"), "---\ndescription: Verify prompts\n---\nResource prompt\n", "utf8"),
    writeFile(join(cwd, ".pi", "themes", "invalid.json"), "{ invalid-theme", "utf8"),
    writeFile(join(cwd, "AGENTS.md"), "# Project instructions\n", "utf8"),
  ]);
}

describe("resources plugin", () => {
  test.each([42, "enabled", []])("rejects a non-object configuration: %j", async (config) => {
    const { context } = await createContext();

    await expect(context.plugin(resourcesPlugin, config as never)).rejects.toBeInstanceOf(Error);
    expect(context.get("piResources")).toBeUndefined();
  });

  test.each([{ trustProject: "yes" }, { noExtensions: 1 }, { noPromptTemplates: [] }, { noThemes: {} }, { noContextFiles: "false" }])(
    "rejects a non-boolean resource option: %j",
    (config) => {
      expect(() => ResourcesConfig(config as never)).toThrow();
    },
  );

  test("rejects unknown configuration without publishing a partial service", async () => {
    const { context } = await createContext();

    await expect(context.plugin(resourcesPlugin, { noSkill: true } as never)).rejects.toThrow(/Unknown pi-resources config keys: noSkill/u);
    expect(context.get("piResources")).toBeUndefined();
  });

  test("rejects a relative cwd when rebuilding cwd-bound resources", async () => {
    const { context } = await createContext();
    await context.plugin(resourcesPlugin, isolatedResources);
    let creationError: unknown;
    try {
      await context.piResources.createForCwd("relative-session-cwd");
    } catch (error) {
      creationError = error;
    }

    expect(creationError).toBeInstanceOf(Error);
    expect((creationError as Error).message).toMatch(/absolute/u);
  });

  test.each(["missing", "file"])("rejects an absolute cwd that is not an existing directory: %s", async (kind) => {
    const { context, cwd } = await createContext();
    await context.plugin(resourcesPlugin, isolatedResources);
    const invalidCwd = join(cwd, kind);
    if (kind === "file") await writeFile(invalidCwd, "not a directory", "utf8");
    let creationError: unknown;
    try {
      await context.piResources.createForCwd(invalidCwd);
    } catch (error) {
      creationError = error;
    }

    expect(creationError).toBeInstanceOf(Error);
    expect((creationError as Error).message).toMatch(/existing directory/u);
  });

  test("loads every enabled resource category from a trusted project", async () => {
    const { context, cwd } = await createContext();
    const marker = join(cwd, "extension-loaded.txt");
    await createProjectResources(cwd, marker);

    await context.plugin(resourcesPlugin, { trustProject: true });

    await expect(access(marker)).resolves.toBeUndefined();
    expect(context.piResources.resourceLoader.getSkills().skills.some((skill) => skill.name === "resource-probe")).toBe(true);
    expect(context.piResources.resourceLoader.getPrompts().prompts.some((prompt) => prompt.name === "resource-probe")).toBe(true);
    expect(context.piResources.resourceLoader.getThemes().diagnostics.some((diagnostic) => diagnostic.path?.endsWith("invalid.json"))).toBe(true);
    expect(context.piResources.resourceLoader.getAgentsFiles().agentsFiles.some((file) => file.path === join(cwd, "AGENTS.md"))).toBe(true);
  });

  test("honors every resource-category disable flag", async () => {
    const { context, cwd } = await createContext();
    const marker = join(cwd, "extension-loaded.txt");
    await createProjectResources(cwd, marker);

    await context.plugin(resourcesPlugin, { trustProject: true, ...isolatedResources });

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(context.piResources.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(context.piResources.resourceLoader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(context.piResources.resourceLoader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(context.piResources.resourceLoader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(context.piResources.resourceLoader.getAgentsFiles()).toEqual({ agentsFiles: [] });
  });

  test("loads user-owned agent extensions even when project resources are untrusted", async () => {
    const { context, agentDir } = await createContext();
    const marker = join(agentDir, "extension-loaded.txt");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "probe.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export default function () {}`,
      "utf8",
    );

    await context.plugin(resourcesPlugin, { trustProject: false, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });

    await expect(access(marker)).resolves.toBeUndefined();
  });

  test("explicit distrust overrides a saved trusted decision", async () => {
    const { context, cwd, agentDir } = await createContext();
    const marker = join(cwd, "extension-loaded.txt");
    await createProjectResources(cwd, marker);
    new ProjectTrustStore(agentDir).set(cwd, true);

    await context.plugin(resourcesPlugin, { trustProject: false, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(context.piResources.settingsManager.isProjectTrusted()).toBe(false);
  });

  test("explicit trust overrides a saved untrusted decision", async () => {
    const { context, cwd, agentDir } = await createContext();
    const marker = join(cwd, "extension-loaded.txt");
    await createProjectResources(cwd, marker);
    new ProjectTrustStore(agentDir).set(cwd, false);

    await context.plugin(resourcesPlugin, { trustProject: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });

    await expect(access(marker)).resolves.toBeUndefined();
    expect(context.piResources.settingsManager.isProjectTrusted()).toBe(true);
  });

  test("uses the saved trust decision when the profile has no override", async () => {
    const { context, cwd, agentDir } = await createContext();
    const marker = join(cwd, "extension-loaded.txt");
    await createProjectResources(cwd, marker);
    new ProjectTrustStore(agentDir).set(cwd, true);

    await context.plugin(resourcesPlugin, { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });

    await expect(access(marker)).resolves.toBeUndefined();
    expect(context.piResources.settingsManager.isProjectTrusted()).toBe(true);
  });

  test("fails activation on an extension load error without publishing partial resources", async () => {
    const { context, agentDir } = await createContext();
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "broken.js"), `throw new Error("deliberate resource extension failure");`, "utf8");

    let activationError: unknown;
    try {
      await context.plugin(resourcesPlugin, { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    } catch (error) {
      activationError = error;
    }

    expect(activationError).toBeInstanceOf(Error);
    expect((activationError as Error).message).toMatch(/deliberate resource extension failure/u);
    expect(context.get("piResources")).toBeUndefined();
  });

  test("sanitizes and bounds an extension failure before propagating it", async () => {
    const { context, agentDir } = await createContext();
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "oversized-error.js"), `throw new Error("x".repeat(100_000) + "\\0\\nsecond line");`, "utf8");
    let activationError: unknown;
    try {
      await context.plugin(resourcesPlugin, { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    } catch (error) {
      activationError = error;
    }

    expect(activationError).toBeInstanceOf(Error);
    const message = (activationError as Error).message;
    expect(message.length).toBeLessThanOrEqual(4_096);
    expect(message).not.toContain("\0");
    expect(message.split("\n")).toHaveLength(2);
  });

  test("publishes non-fatal loader diagnostics for the application surface", async () => {
    const { context, cwd } = await createContext();
    await mkdir(join(cwd, ".pi", "themes"), { recursive: true });
    const themePath = join(cwd, ".pi", "themes", "invalid.json");
    await writeFile(themePath, "{ invalid-theme", "utf8");

    await context.plugin(resourcesPlugin, { trustProject: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true });

    expect(context.piResources.diagnostics.some((diagnostic) => diagnostic.type === "warning" && diagnostic.message.includes(themePath))).toBe(true);
  });

  test("bounds the published resource diagnostic inventory with an omission summary", async () => {
    const { context, cwd } = await createContext();
    const themes = join(cwd, ".pi", "themes");
    await mkdir(themes, { recursive: true });
    await Promise.all(Array.from({ length: 110 }, async (_, index) => writeFile(join(themes, `invalid-${index}.json`), "{ invalid-theme", "utf8")));

    await context.plugin(resourcesPlugin, { trustProject: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true });

    expect(context.piResources.diagnostics).toHaveLength(100);
    expect(context.piResources.diagnostics.at(-1)).toEqual({ type: "warning", message: "Resource diagnostics omitted: 11 additional warnings" });
  });

  test("fails activation when an extension registers an invalid provider", async () => {
    const { context, agentDir } = await createContext();
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "invalid-provider.js"),
      `export default function (pi) { pi.registerProvider("invalid-provider", { streamSimple() {} }); }`,
      "utf8",
    );
    let activationError: unknown;
    try {
      await context.plugin(resourcesPlugin, { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    } catch (error) {
      activationError = error;
    }

    expect(activationError).toBeInstanceOf(Error);
    expect((activationError as Error).message).toMatch(/invalid-provider.*api.*required/isu);
    expect(context.get("piResources")).toBeUndefined();
    expect(context.piModelRuntime.runtime.getRegisteredProviderIds()).not.toContain("invalid-provider");
  });

  test("surfaces invalid trusted project settings as a warning while retaining global settings", async () => {
    const { context, cwd, agentDir } = await createContext();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), "{ invalid-project-settings", "utf8");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 12_345 }), "utf8");

    await context.plugin(resourcesPlugin, { trustProject: true, ...isolatedResources });

    expect(context.piResources.settingsManager.getHttpIdleTimeoutMs()).toBe(12_345);
    expect(
      context.piResources.diagnostics.some(
        (diagnostic) => diagnostic.type === "warning" && /Invalid project settings file.*settings\.json/isu.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  test("keeps cwd-bound resources and diagnostics isolated when rebuilding for another cwd", async () => {
    const { context, cwd } = await createContext();
    const otherCwd = await mkdtemp(join(tmpdir(), "pi-harness-resources-other-cwd-"));
    await writeFile(join(cwd, "AGENTS.md"), "# Initial project\n", "utf8");
    await writeFile(join(otherCwd, "AGENTS.md"), "# Other project\n", "utf8");
    await context.plugin(resourcesPlugin, { ...isolatedResources, noContextFiles: false });

    const other = await context.piResources.createForCwd(otherCwd);

    expect(context.piResources.cwd).toBe(cwd);
    expect(context.piResources.resourceLoader.getAgentsFiles().agentsFiles).toEqual([{ path: join(cwd, "AGENTS.md"), content: "# Initial project\n" }]);
    expect(other.cwd).toBe(otherCwd);
    expect(other.resourceLoader.getAgentsFiles().agentsFiles).toEqual([{ path: join(otherCwd, "AGENTS.md"), content: "# Other project\n" }]);
    expect(other.diagnostics).not.toBe(context.piResources.diagnostics);
  });

  test("removes the resources service on plugin disposal", async () => {
    const { context } = await createContext();
    await context.plugin(resourcesPlugin, isolatedResources);
    expect(context.get("piResources")).toBeDefined();

    await context.fiber.dispose();

    expect(context.get("piResources")).toBeUndefined();
  });
});
