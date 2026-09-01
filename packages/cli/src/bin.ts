#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliEnvironment } from "./main.js";
import { shouldRelaunchForDevelopmentProfile, superviseDevelopmentProcess } from "./relaunch.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const configuredAgentDir = process.env.PI_AGENT_DIR?.trim();
const agentDir = configuredAgentDir === undefined || configuredAgentDir.length === 0 ? join(homedir(), ".pi", "agent") : resolve(configuredAgentDir);

const environment: CliEnvironment = {
  cwd: process.cwd(),
  agentDir,
  version: packageJson.version,
  supervised: process.env.PI_HARNESS_SUPERVISED === "1",
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  shutdownTimeoutMs: 5_000,
  forceExit(code) {
    process.exit(code);
  },
  onSignal(listener) {
    const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = signals.map((signal) => {
      const handler = () => listener(signal);
      process.on(signal, handler);
      return { signal, handler };
    });
    return () => {
      for (const { signal, handler } of handlers) process.off(signal, handler);
    };
  },
};

const args = process.argv.slice(2);
if (shouldRelaunchForDevelopmentProfile(args, process.execArgv)) {
  try {
    process.exitCode = await superviseDevelopmentProcess(process.execPath, ["--expose-internals", ...process.execArgv, fileURLToPath(import.meta.url), ...args], { stdio: "inherit", env: { ...process.env, PI_HARNESS_SUPERVISED: "1" } });
  } catch (error) {
    process.stderr.write(`Pi Harness could not start the supervised development process: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  process.exitCode = await runCli(args, environment);
}
