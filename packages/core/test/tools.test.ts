import { readFile, rm } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import toolsPlugin, { Config as ToolsConfig } from "../src/plugins/tools.js";
import { createTestRuntimeContext } from "./runtime-fixture.js";

const contexts: Context[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

function createContext(): Context {
  const context = new Context();
  contexts.push(context);
  return context;
}

function textFromToolResult(result: unknown): string {
  if (result === null || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
    throw new Error("Tool result did not contain a content array");
  return result.content
    .map((entry: unknown) => {
      if (entry === null || typeof entry !== "object" || !("type" in entry) || entry.type !== "text" || !("text" in entry) || typeof entry.text !== "string")
        return "";
      return entry.text;
    })
    .join("");
}

describe("tools plugin", () => {
  test.each([42, "read", []])("rejects a non-object configuration: %j", async (config) => {
    const context = createContext();

    await expect(context.plugin(toolsPlugin, config as never)).rejects.toBeInstanceOf(Error);
    expect(context.get("piTools")).toBeUndefined();
    expect(context.get("piPluginUi")).toBeUndefined();
  });

  test.each(["", "   ", "bad tool", "tool\0hidden", "tool\nhidden", "x".repeat(129)])("rejects an unsafe or unbounded configured tool name: %j", (name) => {
    expect(() => ToolsConfig({ names: [name] })).toThrow(/names/u);
  });

  test("rejects an unbounded configured tool inventory", () => {
    expect(() => ToolsConfig({ names: Array.from({ length: 257 }, (_, index) => `tool-${index}`) })).toThrow(/names/u);
  });

  test("rejects duplicate names without publishing either registry", async () => {
    const context = createContext();

    await expect(context.plugin(toolsPlugin, { names: ["read", "read"] })).rejects.toThrow(/unique/u);
    expect(context.get("piTools")).toBeUndefined();
    expect(context.get("piPluginUi")).toBeUndefined();
  });

  test("publishes the default Pi tool allowlist and an empty UI registry", async () => {
    const context = createContext();

    await context.plugin(toolsPlugin);

    expect(context.piTools.snapshot()).toEqual({ names: ["read", "bash", "edit", "write"], customTools: [] });
    await expect(context.piPluginUi.snapshot()).resolves.toEqual([]);
  });

  test("supports an explicitly empty allowlist", async () => {
    const context = createContext();

    await context.plugin(toolsPlugin, { names: [] });

    expect(context.piTools.snapshot()).toEqual({ names: [], customTools: [] });
  });

  test("constructs and executes every default Pi tool through the production runtime", async () => {
    const { context } = await createTestRuntimeContext([], ["read", "bash", "edit", "write"]);
    contexts.push(context);
    temporaryDirectories.push(context.piHarnessLaunch.cwd, context.piHarnessLaunch.agentDir);
    const session = context.piRuntime.session;
    const definitions = new Map(["read", "bash", "edit", "write"].map((name) => [name, session.getToolDefinition(name)]));
    expect([...definitions.values()].every((definition) => definition !== undefined)).toBe(true);
    const write = definitions.get("write");
    const read = definitions.get("read");
    const edit = definitions.get("edit");
    const bash = definitions.get("bash");
    if (write === undefined || read === undefined || edit === undefined || bash === undefined) throw new Error("Default tool construction failed");

    await write.execute("write", { path: "probe.txt", content: "alpha\n" }, undefined, undefined, undefined as never);
    const readResult: unknown = await read.execute("read", { path: "probe.txt" }, undefined, undefined, undefined as never);
    expect(textFromToolResult(readResult)).toContain("alpha");
    await edit.execute("edit", { path: "probe.txt", edits: [{ oldText: "alpha", newText: "beta" }] }, undefined, undefined, undefined as never);
    expect(await readFile(`${context.piHarnessLaunch.cwd}/probe.txt`, "utf8")).toBe("beta\n");
    const bashResult: unknown = await bash.execute("bash", { command: "pwd" }, undefined, undefined, undefined as never);
    expect(textFromToolResult(bashResult)).toContain(context.piHarnessLaunch.cwd);
  });

  test("does not retain the mutable configured array", async () => {
    const context = createContext();
    const names = ["read"];
    await context.plugin(toolsPlugin, { names });

    names.push("bash");

    expect(context.piTools.snapshot().names).toEqual(["read"]);
  });

  test("removes both registries on disposal", async () => {
    const context = createContext();
    await context.plugin(toolsPlugin);
    expect(context.get("piTools")).toBeDefined();
    expect(context.get("piPluginUi")).toBeDefined();

    await context.fiber.dispose();

    expect(context.get("piTools")).toBeUndefined();
    expect(context.get("piPluginUi")).toBeUndefined();
  });
});
