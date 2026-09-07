import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "@pi-harness/plugin-api";

export interface HarnessHomeOptions {
  /** Path of the profile the distribution ships, used to seed the copy the user owns. */
  builtinProfilePath: string;
  /** Directory name under `profiles/`, one per profile the distribution offers. */
  profileName: string;
  /** Overrides the harness home location; the environment and the home directory decide when it is absent. */
  directory?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const harnessHomeManifest =
  JSON.stringify(
    {
      name: "pi-harness-home",
      version: "0.0.0",
      private: true,
      description: "Marketplace plugins installed by the Pi Harness web console",
      type: "module",
    },
    null,
    2,
  ) + "\n";

/**
 * Directory that owns the profile the harness boots and the node_modules the marketplace installs into.
 *
 * It deliberately sits outside the installed package: npm replaces that directory wholesale on every upgrade, so a plugin installed there disappears with the next `npm i -g`, and a prefix owned by root is not writable without elevation in the first place.
 */
export function harnessHomeDirectory(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const configured = env.PI_HARNESS_HOME?.trim();
  return configured === undefined || configured.length === 0 ? join(homedir(), ".pi-harness") : resolve(cwd, configured);
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Materializes the harness home and returns the profile path to boot.
 *
 * The shipped profile seeds the user's copy the first time and keeps updating it for as long as the copy is untouched, so a release that changes what the harness boots still reaches an existing installation. Once the copy diverges — the marketplace appended an entry, or the user edited it — it is left alone, because it now carries state the distribution does not know about.
 */
export async function prepareHarnessProfile(options: HarnessHomeOptions): Promise<string> {
  const directory = options.directory ?? harnessHomeDirectory(options.env ?? process.env, options.cwd ?? process.cwd());
  const profileDirectory = join(directory, "profiles", options.profileName);
  await mkdir(profileDirectory, { recursive: true });
  const manifestPath = join(directory, "package.json");
  // The manifest is what makes npm treat the harness home as the project root and what stops the marketplace's install-directory walk here rather than in the user's home.
  if ((await readIfPresent(manifestPath)) === undefined) await atomicWriteFile(manifestPath, harnessHomeManifest, { encoding: "utf8" });
  const profilePath = join(profileDirectory, "cordis.yml");
  const seedPath = join(profileDirectory, "cordis.seed.yml");
  const builtin = await readFile(options.builtinProfilePath, "utf8");
  const current = await readIfPresent(profilePath);
  if (current === undefined || (current === (await readIfPresent(seedPath)) && current !== builtin)) {
    await atomicWriteFile(profilePath, builtin, { encoding: "utf8" });
    await atomicWriteFile(seedPath, builtin, { encoding: "utf8" });
  }
  return profilePath;
}
