import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const BIN = join(import.meta.dirname, "..", "server-dist", "bin.js");

interface LauncherRun {
  readonly consoleUrl: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
  readonly stderr: string;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

// Boots the built launcher on an ephemeral port with an isolated agent directory, waits for the console URL, sends the signal, and reports how the process exited.
async function runLauncher(signal: NodeJS.Signals, extraEnv: Record<string, string> = {}): Promise<LauncherRun> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-web-bin-"));
  directories.push(agentDir);
  const child = spawn(process.execPath, [BIN], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_HARNESS_PORT: "0",
      PI_AGENT_DIR: agentDir,
      PI_HARNESS_PROVIDER: "anthropic",
      PI_HARNESS_MODEL: "claude-sonnet-4-5",
      ...extraEnv,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })),
  );
  const consoleUrl = await new Promise<string>((resolve, reject) => {
    const check = (chunk: string) => {
      stdout += chunk;
      const match = /Pi Harness web console: (\S+)/u.exec(stdout);
      if (match?.[1] !== undefined) {
        child.stdout.off("data", check);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", check);
    void exit.then(({ code }) => reject(new Error("launcher exited before printing the console URL (code " + String(code) + "): " + stderr)));
  });
  const started = Date.now();
  child.kill(signal);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const result = await exit;
  clearTimeout(timeout);
  return { consoleUrl, ...result, elapsedMs: Date.now() - started, stderr };
}

describe("web launcher", () => {
  test("completes graceful shutdown on SIGINT and exits with code 130 instead of dying by signal", async () => {
    const run = await runLauncher("SIGINT");
    expect(run.consoleUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(run.signal).toBeNull();
    expect(run.code).toBe(130);
    expect(run.stderr).not.toContain("shutdown timed out");
    expect(run.elapsedMs).toBeLessThan(4_000);
  }, 30_000);

  test("maps SIGTERM to exit code 143", async () => {
    const run = await runLauncher("SIGTERM");
    expect(run.signal).toBeNull();
    expect(run.code).toBe(143);
    expect(run.stderr).not.toContain("shutdown timed out");
  }, 30_000);

  test("binds a bracketed IPv6 loopback host by stripping the brackets", async () => {
    const run = await runLauncher("SIGINT", { PI_HARNESS_HOST: "[::1]" });
    expect(run.consoleUrl).toMatch(/^http:\/\/\[::1\]:\d+$/u);
    expect(run.code).toBe(130);
  }, 30_000);
});
