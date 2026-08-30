import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolveProfileConfigOptions {
  profile?: string;
  configPath?: string;
  cwd?: string;
  profilesDir?: string;
}

export async function resolveProfileConfig(_options: ResolveProfileConfigOptions = {}): Promise<string> {
  const options = _options;
  if (options.profile !== undefined && options.configPath !== undefined) throw new Error("profile and configPath cannot be used together");
  const cwd = options.cwd ?? process.cwd();
  let configPath: string;
  if (options.configPath !== undefined) {
    configPath = resolve(cwd, options.configPath);
  } else {
    const profile = options.profile ?? "default";
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(profile)) throw new Error(`Invalid profile name: ${profile}`);
    const profilesDir = options.profilesDir ?? fileURLToPath(new URL("../profiles", import.meta.url));
    configPath = resolve(profilesDir, profile, "cordis.yml");
  }
  try {
    await access(configPath);
  } catch (cause) {
    throw new Error(`Pi Harness profile config does not exist or is not readable: ${configPath}`, { cause });
  }
  return configPath;
}
