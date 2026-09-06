import { spawn, type SpawnOptions } from "node:child_process";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parseLauncherArgs } from "./args.js";

export const PI_HARNESS_RESTART_EXIT_CODE = 75;
const RESTART_WINDOW_MS = 10_000;
const RESTART_WINDOW_LIMIT = 5;
const RESTART_BACKOFF_MS = 250;

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const number = constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

export async function superviseDevelopmentProcess(command: string, args: readonly string[], options: SpawnOptions = {}): Promise<number> {
  const restarts: number[] = [];
  while (true) {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(command, [...args], options);
      const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
      const handlers = signals.map((signal) => {
        const handler = () => child.kill(signal);
        process.on(signal, handler);
        return { signal, handler };
      });
      const cleanup = () => {
        for (const { signal, handler } of handlers) process.off(signal, handler);
      };
      child.once("error", (error) => {
        cleanup();
        if (child.pid !== undefined) child.kill("SIGKILL");
        reject(error);
      });
      child.once("exit", (code, signal) => {
        cleanup();
        resolve({ code, signal });
      });
    });
    if (result.code !== PI_HARNESS_RESTART_EXIT_CODE) return result.code ?? signalExitCode(result.signal);
    const startedAt = Date.now();
    while (restarts.length > 0 && startedAt - (restarts[0] ?? 0) > RESTART_WINDOW_MS) restarts.shift();
    restarts.push(startedAt);
    if (restarts.length > RESTART_WINDOW_LIMIT) {
      process.stderr.write(`Pi Harness development child requested ${restarts.length} restarts within ${RESTART_WINDOW_MS / 1_000}s; giving up\n`);
      return 1;
    }
    await delay(RESTART_BACKOFF_MS);
  }
}

export function shouldRelaunchForDevelopmentProfile(args: readonly string[], execArgv: readonly string[]): boolean {
  if (execArgv.includes("--expose-internals")) return false;
  try {
    const invocation = parseLauncherArgs(args);
    return invocation.mode === "run" && invocation.configPath === undefined && invocation.profile === "development" && !invocation.dumpConfig;
  } catch {
    return false;
  }
}
