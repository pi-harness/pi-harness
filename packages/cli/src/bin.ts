#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliEnvironment } from "./main.js";
import { shouldRelaunchForDevelopmentProfile } from "./relaunch.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const environment: CliEnvironment = {
  cwd: process.cwd(),
  agentDir: process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  version: packageJson.version,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
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
  const child = spawnSync(process.execPath, ["--expose-internals", ...process.execArgv, fileURLToPath(import.meta.url), ...args], { stdio: "inherit" });
  if (child.error !== undefined) throw child.error;
  process.exitCode = child.status ?? (child.signal === "SIGINT" ? 130 : child.signal === "SIGHUP" ? 129 : child.signal === "SIGTERM" ? 143 : 1);
} else {
  process.exitCode = await runCli(args, environment);
}
