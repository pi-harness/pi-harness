import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

const MAIN_URL = pathToFileURL(join(import.meta.dirname, "..", "dist", "main.js")).href;

describe("stdin shutdown", () => {
  test("exits on a signal while a prompt read is still pending on an open stdin pipe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-stdin-"));
    const pluginPath = join(directory, "application.mjs");
    const configPath = join(directory, "cordis.yml");
    const runnerPath = join(directory, "runner.mjs");
    await writeFile(
      pluginPath,
      `export default { inject: ["piHarnessStdio"], apply(ctx) { ctx.provide("piApplication", { async run() { await ctx.piHarnessStdio.readPrompt(); return 0; } }); } };`,
      "utf8",
    );
    await writeFile(configPath, JSON.stringify([{ name: pathToFileURL(pluginPath).href, config: {} }]), "utf8");
    await writeFile(
      runnerPath,
      `
import { runCli } from ${JSON.stringify(MAIN_URL)};
const environment = {
  cwd: ${JSON.stringify(directory)},
  agentDir: ${JSON.stringify(directory)},
  version: "0.0.0-test",
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  shutdownTimeoutMs: 1000,
  forceExit(code) { process.stderr.write("FORCED\\n"); process.exit(code); },
  onSignal(listener) {
    const handler = () => listener("SIGTERM");
    process.on("SIGTERM", handler);
    return () => process.off("SIGTERM", handler);
  },
};
process.stderr.write("READY\\n");
process.exitCode = await runCli(["--config", ${JSON.stringify(configPath)}], environment);
`,
      "utf8",
    );

    const child = spawn(process.execPath, [runnerPath], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve) => {
      const check = () => {
        if (stderr.includes("READY")) {
          child.stderr.off("data", check);
          resolve();
        }
      };
      child.stderr.on("data", check);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGTERM");

    const exit = await Promise.race([
      new Promise<{ code: number | null }>((resolve) => child.once("exit", (code) => resolve({ code }))),
      new Promise<{ code: "timeout" }>((resolve) => setTimeout(() => resolve({ code: "timeout" }), 8_000)),
    ]);
    if (exit.code === "timeout") child.kill("SIGKILL");

    expect(exit.code).toBe(143);
    expect(stderr).not.toContain("FORCED");
  }, 20_000);
});
