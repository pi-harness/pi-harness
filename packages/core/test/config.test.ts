import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { EmptyConfig, provideLaunchContext } from "@pi-harness/plugin-api";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import resourcesPlugin from "../src/plugins/resources.js";
import sessionPlugin from "../src/plugins/session.js";
import toolsPlugin from "../src/plugins/tools.js";
import { Config as ModelsConfig } from "../src/plugins/models.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createContext(): Promise<{ context: Context; cwd: string; agentDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-config-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-config-agent-"));
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  return { context, cwd, agentDir };
}

describe("plugin configuration validation", () => {
  test("rejects non-plain and symbol-keyed empty plugin configuration", () => {
    expect(() => EmptyConfig([] as never)).toThrow(/object/iu);
    expect(() => EmptyConfig(Object.create({ inherited: true }))).toThrow(/plain object/iu);
    const symbolConfig = { [Symbol("unexpected")]: true };
    expect(() => EmptyConfig(symbolConfig)).toThrow(/unknown config keys/iu);
  });

  test("rejects an unknown key instead of silently restoring the default toolset", async () => {
    const { context } = await createContext();

    await expect(context.plugin(toolsPlugin, { name: ["read"] } as never)).rejects.toThrow(/Unknown pi-tools config keys: name/);
    expect(context.get("piTools")).toBeUndefined();
  });

  test("rejects an unknown key in the session plugin", async () => {
    const { context } = await createContext();

    await expect(context.plugin(sessionPlugin, { storage: "memory", directroy: "/tmp/x" } as never)).rejects.toThrow(
      /Unknown pi-session config keys: directroy/,
    );
  });

  test("rejects an empty session directory instead of writing transcripts to the launch cwd", async () => {
    const { context } = await createContext();

    await expect(context.plugin(sessionPlugin, { storage: "jsonl", directory: "" })).rejects.toThrow(/directory/);
  });

  test("falls back to the agent directory when the session directory is null", async () => {
    const { context, agentDir } = await createContext();

    await context.plugin(sessionPlugin, { storage: "jsonl", directory: null } as never);

    expect(context.piSession.manager.getSessionDir()).toBe(join(agentDir, "sessions"));
  });

  test("rejects blank provider and model identifiers at validation time", () => {
    expect(() => ModelsConfig({ provider: "", model: "deepseek-v4-flash" })).toThrow(/provider/);
    expect(() => ModelsConfig({ provider: "deepseek", model: "" })).toThrow(/model/);
  });

  test("rejects a blank core tool name", async () => {
    const { context } = await createContext();

    await expect(context.plugin(toolsPlugin, { names: [""] })).rejects.toThrow(/names/);
  });
});

describe("project trust", () => {
  test("does not load project-local extensions from an untrusted working directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-untrusted-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-untrusted-agent-"));
    const marker = join(cwd, "executed.txt");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extensions", "evil.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default function (pi) {};`,
      "utf8",
    );
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piModelRuntime", {
      runtime: await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(agentDir, "auth.json") }),
      provider: "none",
      model: "none",
    });

    await context.plugin(resourcesPlugin, { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });

    await expect(access(marker)).rejects.toThrow();
    expect(context.piResources.diagnostics.some((diagnostic) => diagnostic.message.includes("not trusted"))).toBe(true);
  }, 30_000);

  test("loads project-local extensions when the profile opts in", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-trusted-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-trusted-agent-"));
    const marker = join(cwd, "executed.txt");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extensions", "probe.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default function (pi) {};`,
      "utf8",
    );
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piModelRuntime", {
      runtime: await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(agentDir, "auth.json") }),
      provider: "none",
      model: "none",
    });

    await context.plugin(resourcesPlugin, { trustProject: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });

    await expect(access(marker)).resolves.toBeUndefined();
  }, 30_000);
});

describe("launch context", () => {
  test("rejects a relative agent directory so credentials cannot land in the working directory", () => {
    const context = new Context();
    contexts.push(context);

    expect(() => provideLaunchContext(context, { cwd: "/tmp", agentDir: "", args: [], requestExit() {} })).toThrow(/agent directory must be an absolute path/);
    expect(() => provideLaunchContext(context, { cwd: "relative", agentDir: "/tmp", args: [], requestExit() {} })).toThrow(/cwd must be an absolute path/);
  });

  test("exposes the launch directory as a URL that survives percent, hash and question marks", () => {
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd: "/tmp/a%20b#c?d", agentDir: "/tmp", args: [], requestExit() {} });

    const cwdUrl = context.piHarnessLaunch.cwdUrl;
    expect(cwdUrl).toBeDefined();
    expect(new URL(cwdUrl ?? "").pathname).toBe("/tmp/a%2520b%23c%3Fd");
  });
});
