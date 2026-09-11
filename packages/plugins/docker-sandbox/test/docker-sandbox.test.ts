import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import dockerSandboxPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

import type * as FsPromises from "node:fs/promises";

// Hold real temporary-directory cleanup after removal to exercise the final result publication boundary.
const cleanupHooks = vi.hoisted(() => ({ afterRemove: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const rm: typeof actual.rm = async (...args) => {
    await actual.rm(...args);
    if (typeof args[0] === "string" && /pi-harness-docker-sandbox-[A-Za-z0-9]{6}$/u.test(args[0])) await cleanupHooks.afterRemove?.();
  };
  return { ...actual, rm };
});

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

async function installFakeDocker(cwd: string, output = "界".repeat(5000) + "\u001b[31mBAD\u001b[0m\0"): Promise<string> {
  const bin = join(cwd, "bin");
  const log = join(cwd, "docker.log");
  await mkdir(bin);
  const executable = join(bin, "docker");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_HARNESS_FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "run") process.stdout.write(${JSON.stringify(output)});
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  process.env.PI_HARNESS_FAKE_DOCKER_LOG = log;
  return log;
}

describe("Docker sandbox production boundaries", () => {
  test.each([
    ["Cannot connect to the Docker daemon", "Docker image inspection failed"],
    ["permission denied while trying to connect to the Docker daemon socket", "Docker image inspection failed"],
    ["Error response from daemon: No such image: alpine:3.20", "Docker image is not available locally: alpine:3.20"],
  ])("reports image-inspection failures accurately: %s", async (diagnostic, expected) => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const log = await installFakeDocker(fixture.cwd);
    await writeFile(
      join(fixture.cwd, "bin", "docker"),
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_HARNESS_FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write(${JSON.stringify(diagnostic)});
process.exit(1);
`,
      "utf8",
    );
    try {
      await expect(fixture.tool.execute("inspect", { command: ["printf", "ok"] }, undefined, undefined, {} as never)).rejects.toThrow(expected);
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test.each([12_000, 12_001])("discloses output clipping only beyond the byte budget (%i)", async (length) => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    await installFakeDocker(fixture.cwd, "x".repeat(length));
    try {
      const result = await fixture.tool.execute("boundary", { command: ["printf", "boundary"] }, undefined, undefined, {} as never);
      const output = (result.details as { output: string }).output;
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(12_000);
      if (length === 12_000) expect(output).toBe("x".repeat(length));
      else expect(output).toMatch(/^\[Output truncated: showing tail only\.\]\n/u);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

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
      expect(details.output).toMatch(/^\[Output truncated: showing tail only\.\]\n/u);
      expect(result.content).toEqual([{ type: "text", text: `Docker sandbox exited with 0.\n${details.output}` }]);
      expect(details.output).not.toContain("\u001b");
      expect(details.output).not.toContain("\u0000");
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls[0]).toEqual(["image", "inspect", "alpine:3.20"]);
      const entrypointIndex = calls[1]!.indexOf("--entrypoint");
      expect(entrypointIndex).toBeGreaterThan(0);
      expect(calls[1]![entrypointIndex + 1]).toBe("");
      expect(calls[1]!.slice(-3)).toEqual(["alpine:3.20", "printf", "ok"]);
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

test("mounts the active native workspace and clears the previous session report", async () => {
  if (process.platform === "win32") return;
  const fixture = await createFixture();
  const active = join(fixture.cwd, "active");
  await mkdir(active);
  const log = await installFakeDocker(fixture.cwd);
  let session = { sessionId: "first", sessionManager: { getCwd: () => fixture.cwd } };
  fixture.context.provide("piRuntime", {
    get session() {
      return session;
    },
  } as never);
  try {
    await fixture.tool.execute("first", { command: ["printf", "ok"] }, undefined, undefined, {} as never);
    session = { sessionId: "second", sessionManager: { getCwd: () => active } };
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: null } }]);
    await fixture.tool.execute("active", { command: ["printf", "ok"] }, undefined, undefined, {} as never);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const run = calls[3]!;
    expect(run[run.indexOf("--mount") + 1]).toBe(`type=bind,"src=${active}",dst=/workspace,readonly`);
    const pending = fixture.tool.execute("pending", { command: ["printf", "old"] }, undefined, undefined, {} as never);
    session = { sessionId: "third", sessionManager: { getCwd: () => active } };
    await expect(pending).rejects.toThrow(/workspace changed/iu);
    const finalCalls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(finalCalls.filter((args) => args[0] === "run")).toHaveLength(2);
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: null } }]);
  } finally {
    await fixture.context.fiber.dispose();
  }
});

test.each([0, 7])("discards an already-started container result with exit code %i after an in-place session change", async (exitCode) => {
  if (process.platform === "win32") return;
  const fixture = await createFixture();
  const log = await installFakeDocker(fixture.cwd);
  const ready = join(fixture.cwd, "ready"),
    release = join(fixture.cwd, "release");
  await writeFile(
    join(fixture.cwd, "bin/docker"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_HARNESS_FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "run") {
  fs.writeFileSync(${JSON.stringify(ready)}, "ready");
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    process.stdout.write("old session output");
    process.exit(${exitCode});
  }, 10);
}
`,
  );
  let id = "first";
  fixture.context.provide("piRuntime", {
    session: {
      get sessionId() {
        return id;
      },
      sessionManager: { getCwd: () => fixture.cwd },
    },
  } as never);
  try {
    const result = fixture.tool.execute("held", { command: ["printf", "old"] }, undefined, undefined, {} as never).then(
      () => "unexpected success",
      (error: unknown) => String(error),
    );
    const deadline = Date.now() + 3000;
    while (true) {
      try {
        await access(ready);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    id = "replacement";
    await writeFile(release, "release");
    expect(await result).toMatch(/workspace changed/iu);
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: null } }]);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args[0] === "rm" && args[1] === "--force")).toBe(true);
  } finally {
    await writeFile(release, "release");
    await fixture.context.fiber.dispose();
  }
});

test.each([0, 7])("rejects scope changes during final cleanup after container exit %i", async (exitCode) => {
  if (process.platform === "win32") return;
  const fixture = await createFixture();
  await installFakeDocker(fixture.cwd);
  const docker = join(fixture.cwd, "bin/docker");
  await writeFile(docker, (await readFile(docker, "utf8")) + `\nif (process.argv[2] === "run") process.exit(${exitCode});\n`);
  let id = "first";
  fixture.context.provide("piRuntime", {
    session: {
      get sessionId() {
        return id;
      },
      sessionManager: { getCwd: () => fixture.cwd },
    },
  } as never);
  let reached!: () => void, release!: () => void;
  const cleaning = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanupHooks.afterRemove = async () => {
    reached();
    await held;
  };
  try {
    const result = fixture.tool.execute("cleanup", { command: ["printf", "old"] }, undefined, undefined, {} as never).then(
      () => "unexpected success",
      (error: unknown) => String(error),
    );
    await cleaning;
    id = "replacement";
    release();
    expect(await result).toMatch(/workspace changed/iu);
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: null } }]);
  } finally {
    cleanupHooks.afterRemove = undefined;
    release();
    await fixture.context.fiber.dispose();
  }
});

test.each(["missing", "denied"])("requires confirmed absence after auto-removal races cleanup: %s", async (outcome) => {
  if (process.platform === "win32") return;
  const fixture = await createFixture();
  const log = await installFakeDocker(fixture.cwd);
  const counter = join(fixture.cwd, "inspections");
  await writeFile(
    join(fixture.cwd, "bin/docker"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_HARNESS_FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "run") { process.stderr.write("command failed"); process.exit(7); }
if (process.argv[2] === "rm") { process.stderr.write("removal of container is already in progress"); process.exit(1); }
if (process.argv[2] === "container") {
  if (!fs.existsSync(${JSON.stringify(counter)})) { fs.writeFileSync(${JSON.stringify(counter)},"1"); process.stdout.write("[]"); }
  else { process.stderr.write(${JSON.stringify(outcome === "missing" ? "Error: No such container: fixture" : "Docker daemon permission denied")}); process.exit(1); }
}
`,
  );
  try {
    const result = fixture.tool.execute("race", { command: ["printf", "ok"] }, undefined, undefined, {} as never);
    if (outcome === "missing") await expect(result).resolves.toMatchObject({ details: { status: "failed", exitCode: 7, output: "command failed" } });
    else await expect(result).rejects.toThrow(/cleanup could not be confirmed.*permission denied/iu);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[0] === "container" && args[1] === "inspect")).toHaveLength(2);
  } finally {
    await fixture.context.fiber.dispose();
  }
});
