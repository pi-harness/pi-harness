export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

export type LauncherInvocation = { mode: "help" } | { mode: "version" } | { mode: "run"; profile?: string; configPath?: string; dumpConfig: boolean; args: string[] };

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value === "--") throw new CliUsageError(`${option} requires a value`);
  return value;
}

export function parseLauncherArgs(args: readonly string[]): LauncherInvocation {
  let profile = "default";
  let profileExplicit = false;
  let configPath: string | undefined;
  let dumpConfig = false;
  const applicationArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      applicationArgs.push(...args.slice(index));
      break;
    }
    if (arg === "--help" || arg === "-h") return { mode: "help" };
    if (arg === "--version" || arg === "-v") return { mode: "version" };
    if (arg === "--dump-config") {
      dumpConfig = true;
      continue;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (profileExplicit) throw new CliUsageError("--profile may only be specified once");
      profile = arg === "--profile" ? optionValue(args, index, "--profile") : arg.slice("--profile=".length);
      if (profile.length === 0) throw new CliUsageError("--profile requires a value");
      profileExplicit = true;
      if (arg === "--profile") index += 1;
      continue;
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      if (configPath !== undefined) throw new CliUsageError("--config may only be specified once");
      configPath = arg === "--config" ? optionValue(args, index, "--config") : arg.slice("--config=".length);
      if (configPath.length === 0) throw new CliUsageError("--config requires a value");
      if (arg === "--config") index += 1;
      continue;
    }
    applicationArgs.push(...args.slice(index));
    break;
  }
  if (profileExplicit && configPath !== undefined) throw new CliUsageError("--profile and --config cannot be used together");
  return configPath === undefined
    ? { mode: "run", profile, dumpConfig, args: applicationArgs }
    : { mode: "run", configPath, dumpConfig, args: applicationArgs };
}
