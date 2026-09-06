import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";

const BIN = join(import.meta.dirname, "..", "server-dist", "bin.js");

interface LauncherRun {
  readonly consoleUrl: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
  readonly stderr: string;
}

interface LauncherExit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-harness-web-bin-${label}-`));
  directories.push(directory);
  return directory;
}

// Boots the built launcher on an ephemeral port with an isolated agent directory, waits for the console URL, runs the optional probe against the live server, sends the signal, and reports how the process exited.
async function runLauncher(
  signal: NodeJS.Signals,
  extraEnv: Record<string, string> = {},
  spawnCwd?: string,
  probe?: (consoleUrl: string) => Promise<void>,
): Promise<LauncherRun> {
  const agentDir = await makeTempDir("agent");
  const child = spawn(process.execPath, [BIN], {
    stdio: ["ignore", "pipe", "pipe"],
    ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
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
  try {
    await probe?.(consoleUrl);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const started = Date.now();
  child.kill(signal);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const result = await exit;
  clearTimeout(timeout);
  return { consoleUrl, ...result, elapsedMs: Date.now() - started, stderr };
}

// Runs the built launcher until it exits on its own, for the startup guards that must abort before a console URL is ever printed.
async function runLauncherToExit(extraEnv: Record<string, string>): Promise<LauncherExit> {
  const agentDir = await makeTempDir("guard");
  const child = spawn(process.execPath, [BIN], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_HARNESS_PORT: "0",
      PI_AGENT_DIR: agentDir,
      PI_HARNESS_PROVIDER: "anthropic",
      PI_HARNESS_MODEL: "claude-sonnet-4-5",
      PI_HARNESS_DISABLE_UPDATE_CHECK: "1",
      ...extraEnv,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  clearTimeout(timeout);
  return { code, stdout, stderr };
}

// fetch() drops a caller-supplied Host header because "host" is a forbidden header name, so a request that has to carry a proxy hostname goes out over node:http instead.
function statusWithHostHeader(port: number, hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path: "/api/status", headers: { host: hostHeader } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

// Takes a loopback port from the kernel and releases it again, so a launcher run can be probed over HTTP without reading the console URL from stdout.
async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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

  test("resolves a relative PI_AGENT_DIR against the working directory and ignores surrounding whitespace", async () => {
    const workingDir = await makeTempDir("cwd");
    const home = await makeTempDir("home");
    await mkdir(join(workingDir, "agent-state"));

    const run = await runLauncher("SIGINT", { PI_AGENT_DIR: "  ./agent-state  ", HOME: home }, workingDir);

    expect(run.consoleUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(run.stderr).not.toContain("must be an absolute path");
    // Booting writes the model store into the agent directory, so these two paths pin which base the relative value resolved against: the working directory, not the home directory.
    expect(existsSync(join(workingDir, "agent-state", "models-store.json"))).toBe(true);
    expect(existsSync(join(home, "agent-state"))).toBe(false);
    expect(run.code).toBe(130);
  }, 60_000);

  test("treats a blank PI_AGENT_DIR as unset and falls back to the home agent directory", async () => {
    const workingDir = await makeTempDir("cwd");
    const home = await makeTempDir("home");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });

    const run = await runLauncher("SIGINT", { PI_AGENT_DIR: "   ", HOME: home }, workingDir);

    expect(run.stderr).not.toContain("must be an absolute path");
    expect(existsSync(join(home, ".pi", "agent", "models-store.json"))).toBe(true);
    expect(existsSync(join(workingDir, ".pi"))).toBe(false);
    expect(run.code).toBe(130);
  }, 60_000);

  test("keeps serving and shuts down gracefully when a closed stdout pipe breaks the console URL write", async () => {
    const agentDir = await makeTempDir("epipe");
    const port = await reserveLoopbackPort();
    const child = spawn(process.execPath, [BIN], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_HARNESS_PORT: String(port),
        PI_AGENT_DIR: agentDir,
        PI_HARNESS_PROVIDER: "anthropic",
        PI_HARNESS_MODEL: "claude-sonnet-4-5",
        PI_HARNESS_DISABLE_UPDATE_CHECK: "1",
      },
    });
    let stderr = "";
    let exited = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      }),
    );
    // Closing the read end of the pipe is what `pi-harness | head -1` does: the launcher's next write raises EPIPE on process.stdout.
    child.stdout.destroy();

    await expect
      .poll(
        async () => {
          if (exited) return "exited";
          try {
            await fetch(`http://127.0.0.1:${String(port)}/`);
            return "listening";
          } catch {
            return "starting";
          }
        },
        { interval: 200, timeout: 40_000 },
      )
      .not.toBe("starting");
    // The console URL is written shortly after the server starts listening, so wait past that point before deciding the process survived the broken pipe.
    await delay(3_000);

    expect(stderr).not.toContain("EPIPE");
    expect(exited).toBe(false);
    child.kill("SIGINT");
    const result = await exit;
    expect(result.code).toBe(130);
  }, 60_000);
});

describe("web launcher startup guards", () => {
  test("refuses a non-loopback PI_HARNESS_HOST while remote access is not opted in", async () => {
    for (const remoteHost of ["0.0.0.0", "192.0.2.10"]) {
      const run = await runLauncherToExit({ PI_HARNESS_HOST: remoteHost });

      expect(run.stderr).toContain("Refusing non-loopback PI_HARNESS_HOST");
      expect(run.stdout).not.toContain("Pi Harness web console:");
      expect(run.code).not.toBe(0);
    }
  }, 60_000);

  test("binds a host outside the loopback allowlist once PI_HARNESS_ALLOW_REMOTE opts in", async () => {
    // "LOCALHOST" is not one of the literals the launcher treats as loopback, so it takes the opt-in path, yet getaddrinfo still resolves it to the loopback address: the bind succeeds without putting the console on the network.
    const run = await runLauncher("SIGINT", { PI_HARNESS_HOST: "LOCALHOST", PI_HARNESS_ALLOW_REMOTE: "1" });

    expect(run.stderr).not.toContain("Refusing non-loopback PI_HARNESS_HOST");
    expect(run.consoleUrl).toMatch(/^http:\/\/LOCALHOST:\d+$/u);
    expect(run.code).toBe(130);
  }, 60_000);

  test("hands an opted-in host to listen and reports the bind failure when no interface owns it", async () => {
    // 192.0.2.10 is TEST-NET-1 and is assigned to no interface, so this pins that the guard let the host through: the run dies in listen rather than in the guard.
    const run = await runLauncherToExit({ PI_HARNESS_HOST: "192.0.2.10", PI_HARNESS_ALLOW_REMOTE: "1" });

    expect(run.stderr).not.toContain("Refusing non-loopback PI_HARNESS_HOST");
    expect(run.stderr).toContain("EADDRNOTAVAIL");
    expect(run.code).toBe(1);
  }, 60_000);

  test("accepts a proxy hostname in the Host header only when PI_HARNESS_ALLOWED_HOSTS names it", async () => {
    const statuses: number[] = [];
    const run = await runLauncher("SIGINT", { PI_HARNESS_ALLOWED_HOSTS: " proxy.internal.example , " }, undefined, async (consoleUrl) => {
      const port = Number(new URL(consoleUrl).port);
      statuses.push(await statusWithHostHeader(port, `proxy.internal.example:${String(port)}`));
      statuses.push(await statusWithHostHeader(port, `other.internal.example:${String(port)}`));
    });

    expect(statuses).toEqual([200, 400]);
    expect(run.code).toBe(130);
  }, 60_000);

  test("rejects a PI_HARNESS_ALLOWED_HOSTS entry that is not a bare hostname", async () => {
    for (const entry of ["https://proxy.example", "proxy.example:8443", "proxy.example/app"]) {
      const run = await runLauncherToExit({ PI_HARNESS_ALLOWED_HOSTS: entry });

      expect(run.stderr).toContain("PI_HARNESS_ALLOWED_HOSTS entries must be bare hostnames");
      expect(run.stdout).not.toContain("Pi Harness web console:");
      expect(run.code).not.toBe(0);
    }
  }, 60_000);

  test("rejects a PI_HARNESS_PORT that is not an integer inside the valid range", async () => {
    for (const badPort of ["70000", "-1", "abc"]) {
      const run = await runLauncherToExit({ PI_HARNESS_PORT: badPort });

      expect(run.stderr).toContain("PI_HARNESS_PORT must be an integer between 0 and 65535");
      expect(run.stdout).not.toContain("Pi Harness web console:");
      expect(run.code).not.toBe(0);
    }
  }, 60_000);
});
