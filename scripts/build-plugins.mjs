// Builds every packages/plugins/* workspace. A handful of plugins depend on another plugin's package,
// so the projects are grouped into dependency waves and each wave runs in parallel. `--order` prints the
// same waves flattened, which is the order the release has to publish them in.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsRoot = join(root, "packages", "plugins");
const typecheck = process.argv.includes("--typecheck");
const orderOnly = process.argv.includes("--order");

/** @type {Map<string, string[]>} */
const projects = new Map();
for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = entry.name;
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(join(pluginsRoot, directory, "package.json"), "utf8"));
  const manifest = /** @type {{ dependencies?: Record<string, string> }} */ (parsed);
  const siblings = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@pi-harness/plugin-") && name !== "@pi-harness/plugin-api")
    .map((name) => name.slice("@pi-harness/plugin-".length));
  projects.set(directory, siblings);
}

const waves = [];
const built = new Set();
while (built.size < projects.size) {
  const wave = [...projects].filter(([name, siblings]) => !built.has(name) && siblings.every((sibling) => built.has(sibling))).map(([name]) => name);
  if (wave.length === 0) throw new Error(`cyclic plugin dependencies among ${[...projects.keys()].filter((name) => !built.has(name)).join(", ")}`);
  for (const name of wave) built.add(name);
  waves.push(wave);
}

if (orderOnly) {
  for (const wave of waves) for (const name of wave) process.stdout.write(`${join("packages", "plugins", name)}\n`);
  process.exit(0);
}

// Every plugin source and test file belongs to one shared project, so a typecheck is a single program rather than 75 near-identical ones.
if (typecheck) {
  try {
    await run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: pluginsRoot });
  } catch (error) {
    const failure = /** @type {{ stdout?: string; stderr?: string }} */ (error);
    throw new Error(`typecheck failed for packages/plugins\n${failure.stdout ?? ""}${failure.stderr ?? ""}`, { cause: error });
  }
  process.stdout.write(`typechecked ${projects.size} plugin packages in 1 project\n`);
  process.exit(0);
}

const project = "tsconfig.build.json";
const limit = Math.max(1, availableParallelism());
for (const wave of waves) {
  for (let index = 0; index < wave.length; index += limit) {
    await Promise.all(
      wave.slice(index, index + limit).map(async (name) => {
        try {
          await run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", project], { cwd: join(pluginsRoot, name) });
        } catch (error) {
          const failure = /** @type {{ stdout?: string; stderr?: string }} */ (error);
          throw new Error(`build failed for @pi-harness/plugin-${name}\n${failure.stdout ?? ""}${failure.stderr ?? ""}`, { cause: error });
        }
      }),
    );
  }
}

process.stdout.write(`built ${projects.size} plugin packages in ${waves.length} waves\n`);
