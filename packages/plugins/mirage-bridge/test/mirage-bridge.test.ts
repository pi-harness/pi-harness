import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import mirageBridgePlugin from "../src/index.js";

const temporaryDirectories: string[] = [];

async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() - started > 5_000) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// A Mirage stub whose execute subcommand signals readiness, then idles until it is terminated or gives up after five seconds.
async function longRunningFixture(timeoutMs = 30_000) {
  const directory = await mkdtemp(join(tmpdir(), "pi-harness-mirage-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "mirage-stub.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import {writeFileSync } from "node:fs";
if (process.argv[2] === "--version") {
  console.log("mirage 0.9.0");
} else {
  process.on("SIGTERM", () => {
    writeFileSync("terminated", "");
    process.exit(0);
  });
  writeFileSync("ready", "");
  setInterval(() => {}, 100);
  setTimeout(() => process.exit(2), 5_000);
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piHarnessLaunch", { cwd: directory, agentDir: directory } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(mirageBridgePlugin, { executable, workspaceId: "review-sandbox", timeoutMs });
  const execute = tools.snapshot().customTools.find((tool) => tool.name === "mirage_execute");
  if (execute === undefined) throw new Error("mirage_execute was not registered");
  return { directory, context, panels, execute, tools };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mirage bridge", () => {
  test("closes stdin for the CLI non-interactive execute contract", async () => {
    const { context, directory, execute } = await longRunningFixture(1000);
    await writeFile(
      join(directory, "mirage-stub.mjs"),
      '#!/usr/bin/env node\nimport {readFileSync} from "node:fs";\nreadFileSync(0);\nconsole.log("stdin ended");\n',
    );
    try {
      const result = await execute.execute("stdin", { command: "echo ready" }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ exitCode: 0, output: "stdin ended\n" });
      (result.details as { output: string }).output = "changed";
      const doctor = context.piTools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor")!;
      const inspected = await doctor.execute("inspect", {}, undefined, undefined, {} as never);
      expect(inspected.details).toMatchObject({ lastRun: { output: "stdin ended\n" } });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("uses a finite timeout for non-finite configuration", async () => {
    const { context, tools, panels } = await longRunningFixture(Number.NaN);
    try {
      const doctor = tools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor")!;
      await expect(doctor.execute("doctor", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { available: true } });
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { timeoutMs: 60_000 } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("keeps doctor results separate from the persisted panel state", async () => {
    const { context, tools, panels } = await longRunningFixture();
    try {
      const doctor = tools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor")!;
      const result = await doctor.execute("doctor", {}, undefined, undefined, {} as never);
      (result.details as { available: boolean; workspaceId: string }).available = false;
      (result.details as { workspaceId: string }).workspaceId = "changed";
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { available: true, workspaceId: "review-sandbox" } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("checks the official CLI and executes inside the configured virtual workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-mirage-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "mirage-stub.mjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") console.log("mirage 0.9.0");
else console.log(JSON.stringify(process.argv.slice(2)));
`,
      "utf8",
    );
    await chmod(executable, 0o755);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: directory, agentDir: directory } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(mirageBridgePlugin, { executable, workspaceId: "review-sandbox" });
      const doctor = tools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor");
      const execute = tools.snapshot().customTools.find((tool) => tool.name === "mirage_execute");
      expect(doctor).toBeDefined();
      expect(execute).toBeDefined();
      expect(doctor!.executionMode).toBe("sequential");
      expect(doctor!.parameters).toMatchObject({ additionalProperties: false });
      expect(execute!.executionMode).toBe("sequential");
      expect(execute!.parameters).toMatchObject({ additionalProperties: false });
      await expect(doctor!.execute("doctor-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { available: true, version: "mirage 0.9.0", workspaceId: "review-sandbox" },
      });
      await expect(execute!.execute("run-1", { command: "grep -r TODO /workspace" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { exitCode: 0, workspaceId: "review-sandbox", command: "grep -r TODO /workspace" },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([
        { id: "mirage-bridge-panel", data: { available: true, workspaceId: "review-sandbox", lastRun: { exitCode: 0 } } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });
  test("kills the Mirage child and rejects when the tool call is cancelled", async () => {
    const { directory, context, panels, execute } = await longRunningFixture();
    try {
      const caller = new AbortController();
      const execution = execute.execute("run-cancel", { command: "sleep forever" }, caller.signal, undefined, {} as never);
      await waitForFile(join(directory, "ready"));

      caller.abort(new Error("cancelled by test"));

      await expect(execution).rejects.toThrow(/cancelled by test/iu);
      await waitForFile(join(directory, "terminated"));
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "mirage-bridge-panel", data: { lastRun: null } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("kills the Mirage child when the plugin is disposed", async () => {
    const { directory, context, execute } = await longRunningFixture();
    try {
      const execution = execute.execute("run-dispose", { command: "sleep forever" }, undefined, undefined, {} as never);
      await waitForFile(join(directory, "ready"));

      await context.fiber.dispose();

      await expect(execution).rejects.toThrow(/disposed/iu);
      await waitForFile(join(directory, "terminated"));
    } finally {
      await context.fiber.dispose();
    }
  });
});
