import { spawn, type SpawnOptions } from "node:child_process";
import { parseLauncherArgs } from "./args.js";

export const PI_HARNESS_RESTART_EXIT_CODE = 75;

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGTERM") return 143;
  return 1;
}

export async function superviseDevelopmentProcess(command: string, args: readonly string[], options: SpawnOptions = {}): Promise<number> {
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
        reject(error);
      });
      child.once("exit", (code, signal) => {
        cleanup();
        resolve({ code, signal });
      });
    });
    if (result.code === PI_HARNESS_RESTART_EXIT_CODE) continue;
    return result.code ?? signalExitCode(result.signal);
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
