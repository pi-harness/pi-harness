import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { provideLaunchContext } from "../src/services.js";
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
  test("rejects an unknown key instead of silently restoring the default toolset", async () => {
    const { context } = await createContext();

    await expect(context.plugin(toolsPlugin, { name: ["read"] } as never)).rejects.toThrow(/Unknown pi-tools config keys: name/);
    expect(context.get("piTools")).toBeUndefined();
  });

  test("rejects an unknown key in the session plugin", async () => {
    const { context } = await createContext();

    await expect(context.plugin(sessionPlugin, { storage: "memory", directroy: "/tmp/x" } as never)).rejects.toThrow(/Unknown pi-session config keys: directroy/);
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
