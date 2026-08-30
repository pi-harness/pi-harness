#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCli, type CliEnvironment } from "./main.js";

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

process.exitCode = await runCli(process.argv.slice(2), environment);
