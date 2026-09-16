#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentDirectory, coreUpdateNotice, harnessHomeDirectory } from "@pi-harness/core";
import { runCli, type CliEnvironment } from "./main.js";
import { shouldRelaunchForDevelopmentProfile, superviseDevelopmentProcess } from "./relaunch.js";

// The only "error" listener on these streams is the one NodeStdio installs in its constructor, and runCli does
// not construct it until after --help, --version, --dump-config and every usage error have already written. A
// reader that closes early — `pih --help | head` — otherwise raises an unhandled EPIPE and Node prints a crash
// dump over the output that was asked for. A reader going away is not a failure; anything else still fails.
for (const stream of new Set([process.stdout, process.stderr])) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") process.exitCode = 1;
  });
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const agentDir = agentDirectory();

const environment: CliEnvironment = {
  cwd: process.cwd(),
  agentDir,
  harnessHome: harnessHomeDirectory(),
  version: packageJson.version,
  supervised: process.env.PI_HARNESS_SUPERVISED === "1",
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  shutdownTimeoutMs: 5_000,
  ...(process.env.PI_HARNESS_DISABLE_UPDATE_CHECK === "1" ? {} : { checkForUpdates: () => coreUpdateNotice() }),
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
    process.exitCode = await superviseDevelopmentProcess(
      process.execPath,
      ["--expose-internals", ...process.execArgv, fileURLToPath(import.meta.url), ...args],
      { stdio: "inherit", env: { ...process.env, PI_HARNESS_SUPERVISED: "1" } },
    );
  } catch (error) {
    process.stderr.write(`Pi Harness could not start the supervised development process: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  process.exitCode = await runCli(args, environment);
}
