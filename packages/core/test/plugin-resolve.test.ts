import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { bootHarness, type BootedHarness } from "../src/boot.js";
import { resolvePluginEntry } from "../src/plugin-resolve.js";

const execFileAsync = promisify(execFile);

const booted: BootedHarness[] = [];

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (harness) => harness.dispose()));
});

// Lays out a package the way npm does for a marketplace install: a real node_modules next to the profile, with the manifest the package itself publishes.
async function installPackage(root: string, name: string, manifest: Record<string, unknown>, files: Record<string, string>): Promise<string> {
  const directory = join(root, "node_modules", ...name.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }), "utf8");
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), source, "utf8");
  }
  return directory;
}

async function createRoot(): Promise<{ root: string; profilePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-resolve-"));
  return { root, profilePath: join(root, "cordis.yml") };
}

describe("resolvePluginEntry", () => {
  test("resolves a package whose exports declare only an import condition", async () => {
    const { root, profilePath } = await createRoot();
    const directory = await installPackage(
      root,
      "@fixture/plugin",
      {
        type: "module",
        main: "./dist/index.js",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" },
      },
      { "dist/index.js": "export default {};\n" },
    );

    expect(resolvePluginEntry(profilePath, "@fixture/plugin")).toBe(join(directory, "dist", "index.js"));
  });

  test("resolves a subpath through a pattern export", async () => {
    const { root, profilePath } = await createRoot();
    const directory = await installPackage(
      root,
      "@fixture/suite",
      { type: "module", exports: { "./plugins/*": { import: "./dist/plugins/*.js" } } },
      { "dist/plugins/models.js": "export default {};\n" },
    );

    expect(resolvePluginEntry(profilePath, "@fixture/suite/plugins/models")).toBe(join(directory, "dist", "plugins", "models.js"));
  });

  test("falls back to main for a package without an exports map", async () => {
    const { root, profilePath } = await createRoot();
    const directory = await installPackage(root, "legacy-plugin", { main: "./lib/entry.js" }, { "lib/entry.js": "module.exports = {};\n" });

    expect(resolvePluginEntry(profilePath, "legacy-plugin")).toBe(join(directory, "lib", "entry.js"));
  });

  test("walks up to a node_modules above the profile directory", async () => {
    const { root } = await createRoot();
    const directory = await installPackage(root, "@fixture/plugin", { exports: { ".": { import: "./index.js" } } }, { "index.js": "export default {};\n" });
    const nested = join(root, "profiles", "web");
    await mkdir(nested, { recursive: true });

    expect(resolvePluginEntry(join(nested, "cordis.yml"), "@fixture/plugin")).toBe(join(directory, "index.js"));
  });

  test("reports nothing for a package that is not installed or exports no such subpath", async () => {
    const { root, profilePath } = await createRoot();
    await installPackage(root, "@fixture/plugin", { exports: { ".": { import: "./index.js" } } }, { "index.js": "export default {};\n" });

    expect(resolvePluginEntry(profilePath, "@fixture/absent")).toBeUndefined();
    expect(resolvePluginEntry(profilePath, "@fixture/plugin/extra")).toBeUndefined();
  });
});

describe("bootHarness plugin resolution", () => {
  test("loads an ESM-only package installed beside the profile", async () => {
    const { root, profilePath } = await createRoot();
    await installPackage(
      root,
      "@fixture/marketplace-plugin",
      { type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" } },
      { "dist/index.js": `export default function marketplacePlugin(ctx, config) { ctx.provide("fixtureMarketplaceValue", config.value); }\n` },
    );
    await writeFile(profilePath, JSON.stringify([{ name: "@fixture/marketplace-plugin", config: { value: "installed" } }]), "utf8");

    const harness = await bootHarness({ configPath: profilePath });
    booted.push(harness);

    expect(harness.context.get("fixtureMarketplaceValue")).toBe("installed");
  });

  test("loads a package the console installs into a running harness", async () => {
    const { root, profilePath } = await createRoot();
    await writeFile(profilePath, JSON.stringify([]), "utf8");
    // The console installs a marketplace plugin beside the profile and then adds an entry for it to the loader's own root tree, which is a different tree from the one the profile file is mounted in.
    await installPackage(
      root,
      "@fixture/installed-plugin",
      { type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" } },
      { "dist/index.js": `export default function installedPlugin(ctx, config) { ctx.provide("fixtureInstalledValue", config.value); }\n` },
    );

    // Vitest resolves a bare specifier through its own module runner, which hides how Node resolves one, so this runs against the built harness in a real Node process.
    const script = join(root, "install.mjs");
    await writeFile(
      script,
      [
        `import { bootHarness } from ${JSON.stringify(fileURLToPath(new URL("../dist/boot.js", import.meta.url)))};`,
        `const harness = await bootHarness({ configPath: ${JSON.stringify(profilePath)} });`,
        `const id = await harness.context.loader.create({ id: "marketplace-fixture", name: "@fixture/installed-plugin", config: { value: "added" } });`,
        `await harness.context.loader.resolve(id).fiber?.await();`,
        `console.log(harness.context.get("fixtureInstalledValue"));`,
        `await harness.dispose();`,
        "",
      ].join("\n"),
      "utf8",
    );

    const { stdout } = await execFileAsync(process.execPath, [script], { timeout: 30_000 });

    expect(stdout.trim()).toBe("added");
  }, 40_000);
});
