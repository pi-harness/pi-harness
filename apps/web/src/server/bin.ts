#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootHarness, provideLaunchContext } from "@pi-harness/core";
import "@pi-harness/host-webserver";
import type { WebServer } from "@pi-harness/host-webserver";

// Keep the host service declaration in the server entrypoint's type graph.
type HarnessWebServer = WebServer;

const host = process.env.PI_HARNESS_HOST ?? "127.0.0.1";
const DEFAULT_PI_HARNESS_PORT = 3141;
const port = Number(process.env.PI_HARNESS_PORT ?? DEFAULT_PI_HARNESS_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PI_HARNESS_PORT must be an integer between 0 and 65535");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!loopbackHosts.has(host) && process.env.PI_HARNESS_ALLOW_REMOTE !== "1")
  throw new Error("Refusing non-loopback PI_HARNESS_HOST; set PI_HARNESS_ALLOW_REMOTE=1 only on a trusted network");
const cwd = process.cwd();
const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const staticDir = fileURLToPath(new URL("../dist", import.meta.url));
const profilePath = fileURLToPath(new URL("../profile/cordis.yml", import.meta.url));
process.env.PI_HARNESS_WEB_DIST = staticDir;
process.env.PI_HARNESS_HOST = host;
process.env.PI_HARNESS_PORT = String(port);
const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const startupAbort = new AbortController();
let shuttingDown = false;
let resolveExit: (() => void) | undefined;
const processExit = new Promise<void>((resolve) => {
  resolveExit = resolve;
});
let harness: Awaited<ReturnType<typeof bootHarness>> | undefined;
const formatStartupError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (!/Pi model is not registered: everyapi\//u.test(message)) return message;
  return `${message}\n\nThe EveryAPI model catalog is not provisioned in PI_AGENT_DIR. Start with \`everyapi use pi-harness\`, or set PI_HARNESS_PROVIDER and PI_HARNESS_MODEL to a model already registered in that agent directory.`;
};
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  startupAbort.abort(signal);
  if (harness !== undefined) {
    let disposed = false;
    await Promise.race([
      harness.dispose().then(() => {
        disposed = true;
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (!disposed) {
      process.stderr.write("Pi Harness web shutdown timed out\n");
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
      return;
    }
  }
  process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
  resolveExit?.();
};
for (const signal of signals) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
try {
  harness = await bootHarness({
    configPath: profilePath,
    signal: startupAbort.signal,
    prepare(context) {
      provideLaunchContext(context, { cwd, agentDir, configPath: profilePath, args: [], requestExit() {} });
    },
  });
  const webServer = (harness.context as typeof harness.context & { webServer: HarnessWebServer }).webServer;
  process.stdout.write("Pi Harness web console: " + webServer.url + "\n");
  await processExit;
} catch (error) {
  if (!shuttingDown) {
    process.exitCode = 1;
    process.stderr.write(formatStartupError(error) + "\n");
  }
}
