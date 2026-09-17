import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

export interface ResolveProfileConfigOptions {
  profile?: string;
  configPath?: string;
  cwd?: string;
  profilesDir?: string;
}

// The entry tree is handed to the Cordis include loader, which decides what it can parse from the extension alone and reports a rejection as `extension "<ext>" not supported` without naming the file it came from. This resolver already owns the contract that a profile config is a readable file the loader can open, so it is the layer that checks the two things the loader cannot report: that the path is a file at all, and that its extension is one the loader parses.
const PROFILE_CONFIG_EXTENSIONS = new Set([".yml", ".yaml", ".json"]);

// The runtime resolves a profile file; it does not own one. The distribution that ships profiles passes its own directory, so installing the runtime alone never implies a plugin set.
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
    if (options.profilesDir === undefined) throw new Error(`Cannot resolve profile ${profile} without profilesDir`);
    configPath = resolve(options.profilesDir, profile, "cordis.yml");
  }
  let stats;
  try {
    stats = await stat(configPath);
  } catch (cause) {
    throw new Error(`Pi Harness profile config does not exist or is not readable: ${configPath}`, { cause });
  }
  // These throws stay outside the block above so the "does not exist" wording cannot swallow a path that exists and is simply the wrong kind of thing.
  if (stats.isDirectory()) throw new Error(`Pi Harness profile config is a directory, not a YAML or JSON file: ${configPath}`);
  if (!stats.isFile()) throw new Error(`Pi Harness profile config is not a file: ${configPath}`);
  if (!PROFILE_CONFIG_EXTENSIONS.has(extname(configPath).toLowerCase()))
    throw new Error(`Pi Harness profile config must end in .yml, .yaml or .json: ${configPath}`);
  return configPath;
}
