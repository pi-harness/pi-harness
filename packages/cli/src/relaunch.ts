import { parseLauncherArgs } from "./args.js";

export function shouldRelaunchForDevelopmentProfile(args: readonly string[], execArgv: readonly string[]): boolean {
  if (execArgv.includes("--expose-internals")) return false;
  try {
    const invocation = parseLauncherArgs(args);
    return invocation.mode === "run" && invocation.configPath === undefined && invocation.profile === "development" && !invocation.dumpConfig;
  } catch {
    return false;
  }
}
