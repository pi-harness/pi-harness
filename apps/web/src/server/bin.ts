#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { bootHarness, provideLaunchContext } from "@pi-harness/core";
import "@pi-harness/host-webserver";

const host = process.env.PI_HARNESS_HOST ?? "127.0.0.1";
const port = Number(process.env.PI_HARNESS_PORT ?? "3080");
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PI_HARNESS_PORT must be an integer between 0 and 65535");
const cwd = process.cwd();
const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const staticDir = new URL("../dist", import.meta.url).pathname;
const profilePath = new URL("../profile/cordis.yml", import.meta.url).pathname;
process.env.PI_HARNESS_WEB_DIST = staticDir;
process.env.PI_HARNESS_HOST = host;
process.env.PI_HARNESS_PORT = String(port);
const harness = await bootHarness({
  configPath: profilePath,
  prepare(context) {
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  },
});
process.stdout.write("Pi Harness web console: " + harness.context.webServer.url + "\n");
const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
let shuttingDown = false;
for (const signal of signals) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void harness.dispose().then(() => {
      process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
    });
  });
}
await new Promise<void>(() => {});
