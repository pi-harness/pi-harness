import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import dockerSandboxPlugin from "../src/plugins/docker-sandbox.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;
const originalLog = process.env.PI_HARNESS_FAKE_DOCKER_LOG;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalLog === undefined) delete process.env.PI_HARNESS_FAKE_DOCKER_LOG;
  else process.env.PI_HARNESS_FAKE_DOCKER_LOG = originalLog;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRawFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-docker-sandbox-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-docker-sandbox-agent-"));
  temporaryDirectories.push(cwd, agentDir);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  return { context, cwd, panels, tools };
}

async function createFixture() {
  const fixture = await createRawFixture();
  await fixture.context.plugin(dockerSandboxPlugin);
  const tool = fixture.tools.snapshot().customTools.find((candidate) => candidate.name === "sandbox_exec");
  if (tool === undefined) throw new Error("sandbox_exec was not registered");
  return { ...fixture, tool };
}

async function installFakeDocker(cwd: string): Promise<string> {
  const bin = join(cwd, "bin");
  const log = join(cwd, "docker.log");
  await mkdir(bin);
  const executable = join(bin, "docker");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_HARNESS_FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "run") process.stdout.write("界".repeat(5000) + "\\u001b[31mBAD\\u001b[0m\\0");
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  process.env.PI_HARNESS_FAKE_DOCKER_LOG = log;
  return log;
}

describe("Docker sandbox production boundaries", () => {
  test("uses the enforced isolation argv and bounds captured output by UTF-8 bytes", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const log = await installFakeDocker(fixture.cwd);
    try {
      const result = await fixture.tool.execute("run", { command: ["printf", "ok"], image: "alpine:3.20" }, undefined, undefined, {} as never);
      const details = result.details as { output: string; status: string };
      expect(details.status).toBe("completed");
      expect(Buffer.byteLength(details.output, "utf8")).toBeLessThanOrEqual(12_000);
      expect(details.output).toContain("BAD");
      expect(details.output).not.toContain("\u001b");
      expect(details.output).not.toContain("\u0000");
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls[0]).toEqual(["image", "inspect", "alpine:3.20"]);
      expect(calls[1]).toEqual(
        expect.arrayContaining([
          "run",
          "--pull=never",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--pids-limit",
          "256",
        ]),
      );
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("declares a strict sequential schema and rolls back when panel registration fails", async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.tool.executionMode).toBe("sequential");
      const parameters = fixture.tool.parameters as { type: unknown; additionalProperties: unknown };
      expect(parameters.type).toBe("object");
      expect(parameters.additionalProperties).toBe(false);
      await fixture.context.fiber.dispose();
      const second = await createRawFixture();
      second.panels.register({ id: "docker-sandbox-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
      await expect(second.context.plugin(dockerSandboxPlugin)).rejects.toThrow(/already registered.*docker-sandbox-panel/iu);
      expect(second.tools.snapshot().customTools).toEqual([]);
      await second.context.fiber.dispose();
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects blank images and argv entries that exceed byte limits", async () => {
    const fixture = await createFixture();
    try {
      await expect(fixture.tool.execute("blank", { command: ["echo"], image: "   " }, undefined, undefined, {} as never)).rejects.toThrow(
        /image.*non-empty|invalid.*image/iu,
      );
      await expect(fixture.tool.execute("bytes", { command: ["界".repeat(10_000)] }, undefined, undefined, {} as never)).rejects.toThrow(
        /argument.*16384.*bytes/iu,
      );
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects command arrays with inherited, symbol, or extra properties", async () => {
    const fixture = await createFixture();
    try {
      const inheritedParameters = Object.create({ command: ["echo"] }) as { command: string[] };
      await expect(fixture.tool.execute("inherited-parameters", inheritedParameters, undefined, undefined, {} as never)).rejects.toThrow(
        /parameters.*plain object/iu,
      );
      const inherited = Object.create({ 0: "echo" }) as string[];
      Object.defineProperty(inherited, "length", { value: 1, enumerable: false });
      await expect(fixture.tool.execute("inherited", { command: inherited }, undefined, undefined, {} as never)).rejects.toThrow(/command.*array|argument/iu);
      const extra = ["echo"] as string[] & { extra?: string };
      extra.extra = "unexpected";
      await expect(fixture.tool.execute("extra", { command: extra }, undefined, undefined, {} as never)).rejects.toThrow(/command.*property|unknown/iu);
      const symbol = ["echo"] as string[] & { [key: symbol]: boolean };
      symbol[Symbol("extra")] = true;
      await expect(fixture.tool.execute("symbol", { command: symbol }, undefined, undefined, {} as never)).rejects.toThrow(/command.*property|unknown/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("checks lifecycle cancellation before reading raw parameters", async () => {
    const fixture = await createFixture();
    let accessed = false;
    const params = {} as { command?: string[] };
    Object.defineProperty(params, "command", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("Docker parameter accessor executed");
      },
    });
    await fixture.context.fiber.dispose();

    await expect(fixture.tool.execute("disposed", params, undefined, undefined, {} as never)).rejects.toThrow("Docker sandbox plugin disposed");
    expect(accessed).toBe(false);
  });
});
