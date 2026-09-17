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
  const seed = await readIfPresent(seedPath);
  if (current === undefined || (current === seed && current !== builtin)) {
    await atomicWriteFile(profilePath, builtin, { encoding: "utf8" });
    await atomicWriteFile(seedPath, builtin, { encoding: "utf8" });
    return profilePath;
  }
  // A copy with no seed beside it can never be recognized as untouched again, so without this the next release would stop reaching it for good. Writing the seed alone changes nothing the user can see and puts the copy back on the update path.
  if (seed === undefined && current === builtin) await atomicWriteFile(seedPath, builtin, { encoding: "utf8" });
  return profilePath;
}

/**
 * Where the dumped profile came from, so an inspection can say whether it is reading the file that boots or the template a first boot would install.
 *
 * `home-outdated` is the copy `prepareHarnessProfile` still owns: it matches the seed, so nothing was edited into it, and the next boot replaces it with the template the installation now ships.
 */
export type HarnessProfileOrigin = "builtin" | "home" | "home-modified" | "home-outdated";

export interface HarnessProfileDocument {
  /** File the report is about: the copy under the harness home once one exists, and the shipped template before that. */
  readonly path: string;
  /** Document the next boot reads, which for a copy left over from an earlier release is the template that replaces it rather than what is on disk today. */
  readonly contents: string;
  readonly origin: HarnessProfileOrigin;
}

/**
 * Reads the profile a boot would use without creating or rewriting anything.
 *
 * Inspecting a profile must not be the call that materializes a harness home or pulls an existing copy forward to the shipped template, because both are changes the user did not ask for and cannot see. When no copy exists yet this reports the template the next boot would install there instead. It classifies the copy against the seed exactly as `prepareHarnessProfile` does, because a report that called an untouched copy from an older release a user's own edit would name the one file the next boot overwrites.
 */
export async function readHarnessProfile(options: HarnessHomeOptions): Promise<HarnessProfileDocument> {
  const directory = options.directory ?? harnessHomeDirectory(options.env ?? process.env, options.cwd ?? process.cwd());
  const profileDirectory = join(directory, "profiles", options.profileName);
  const profilePath = join(profileDirectory, "cordis.yml");
  const builtin = await readFile(options.builtinProfilePath, "utf8");
  const current = await readIfPresent(profilePath);
  if (current === undefined) return { path: options.builtinProfilePath, contents: builtin, origin: "builtin" };
  if (current === builtin) return { path: profilePath, contents: current, origin: "home" };
  const seed = await readIfPresent(join(profileDirectory, "cordis.seed.yml"));
  if (current === seed) return { path: profilePath, contents: builtin, origin: "home-outdated" };
  return { path: profilePath, contents: current, origin: "home-modified" };
}
