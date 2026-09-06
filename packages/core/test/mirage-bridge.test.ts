import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";
import mirageBridgePlugin from "../src/plugins/mirage-bridge.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mirage bridge", () => {
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
});
