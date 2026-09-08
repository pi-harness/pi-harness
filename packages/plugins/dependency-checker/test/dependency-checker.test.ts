import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import dependencyCheckerPlugin, { inspectManifest, parseRequirements, type DependencyReport } from "../src/index.js";

const temporaryDirectories: string[] = [];
const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setupPlugin(root: string): Promise<{ context: Context; panels: PiPluginUiRegistry; tool: ToolDefinition; tools: PiToolRegistry }> {
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(dependencyCheckerPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "dependency_check");
  if (tool === undefined) throw new Error("dependency_check was not registered");
  return { context, panels, tool, tools };
}

describe("dependency checker", () => {
  test("uses optional dependencies instead of overridden required declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-override-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { feature: "^1.0.0" }, optionalDependencies: { feature: "^2.0.0" } }));
    await expect(inspectManifest(root)).resolves.toMatchObject({
      declared: 1,
      installed: 0,
      missing: [],
      optionalMissing: ["feature"],
      conflicts: [],
      unresolved: [],
    });

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { feature: "workspace:*" }, optionalDependencies: { feature: "^2.0.0" }, peerDependencies: { feature: "^3.0.0" } }),
    );
    await expect(inspectManifest(root)).resolves.toMatchObject({
      missing: ["feature"],
      optionalMissing: [],
      conflicts: [{ name: "feature", constraints: ["^2.0.0", "^3.0.0"] }],
      unresolved: [],
    });
  });

  test("parses Python requirements, detects conflicts, and checks a local virtualenv", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "requests==2.31.0\nrequests>=2.32\nflask>=3.0\n# comment\n-r base.txt\n");
    await mkdir(join(root, ".venv/lib/python3.12/site-packages/requests"), { recursive: true });

    expect(parseRequirements("requests==2.31.0\nrequests>=2.32\n")).toEqual({
      names: ["requests"],
      constraints: [{ name: "requests", constraints: ["==2.31.0", ">=2.32"] }],
      unresolved: [],
      invalid: [],
    });
    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({
      ecosystem: "python",
      declared: 2,
      installed: 1,
      missing: ["flask"],
      invalid: ["-r base.txt"],
      conflicts: [{ name: "requests", constraints: ["==2.31.0", ">=2.32"] }],
    });

    await writeFile(join(root, "requirements.txt"), "requests>=2,<3\nrequests>=3\n");
    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({
      conflicts: [{ name: "requests", constraints: [">=2,<3", ">=3"] }],
    });
  });

  test("reports conflicting npm declarations while preserving installed checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.3.1" }, devDependencies: { react: "19.0.0", vite: "6.0.0" } }));
    await mkdir(join(root, "node_modules/react"), { recursive: true });
    await mkdir(join(root, "node_modules/vite"), { recursive: true });
    await expect(inspectManifest(root)).resolves.toMatchObject({
      ecosystem: "npm",
      declared: 2,
      installed: 2,
      missing: [],
      conflicts: [{ name: "react", constraints: ["18.3.1", "19.0.0"] }],
    });

    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" }, devDependencies: { react: ">=18" } }));
    await expect(inspectManifest(root)).resolves.toMatchObject({ conflicts: [] });

    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" }, peerDependencies: { react: ">=19.0.0" } }));
    await expect(inspectManifest(root)).resolves.toMatchObject({
      conflicts: [{ name: "react", constraints: ["^18.0.0", ">=19.0.0"] }],
    });
  });

  test("detects an empty common npm range even when every pair intersects", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-npm-common-range-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { shared: "1.0.0 || 2.0.0" },
        devDependencies: { shared: "2.0.0 || 3.0.0" },
        peerDependencies: { shared: "1.0.0 || 3.0.0" },
      }),
    );

    await expect(inspectManifest(root)).resolves.toMatchObject({
      conflicts: [{ name: "shared", constraints: ["1.0.0 || 2.0.0", "2.0.0 || 3.0.0", "1.0.0 || 3.0.0"] }],
    });
  });

  test("detects an empty common Python range even when every pair intersects", () => {
    expect(parseRequirements("shared!=0.*\nshared!=1.*\nshared>=0,<2\n")).toMatchObject({
      constraints: [{ name: "shared", constraints: ["!=0.*", "!=1.*", ">=0,<2"] }],
      unresolved: [],
    });
  });

  test("reports Python numeric specifiers outside the supported semver domain as unresolved", () => {
    expect(parseRequirements(`shared>=${"9".repeat(100)}\n`)).toMatchObject({
      constraints: [],
      unresolved: [{ name: "shared", constraints: [`>=${"9".repeat(100)}`] }],
    });
  });

  test("does not return unsafe Unicode controls from dependency constraints", async () => {
    expect(parseRequirements("requests>=1\u202E\uD800\n")).toEqual({
      names: [],
      constraints: [],
      unresolved: [],
      invalid: ["requests>=1"],
    });

    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-npm-control-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^1.0.0\u202E" } }));

    let failure: unknown;
    try {
      await inspectManifest(root);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/constraint.*control/iu);
    expect((failure as Error).message).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
  });

  test("reports duplicate npm declarations that cannot be compared as semver", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-npm-unresolved-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { shared: "workspace:*" },
        devDependencies: { shared: "^1.0.0" },
        peerDependencies: { shared: "^2.0.0" },
      }),
    );

    await expect(inspectManifest(root)).resolves.toMatchObject({
      conflicts: [],
      unresolved: [{ name: "shared", constraints: ["workspace:*", "^1.0.0", "^2.0.0"] }],
    });
  });

  test("reports conditional Python constraints as unresolved instead of conflicting", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-marker-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), 'requests<2; python_version < "3.10"\nrequests>=3; python_version >= "3.10"\n');

    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({
      conflicts: [],
      unresolved: [{ name: "requests", constraints: ['<2; python_version < "3.10"', '>=3; python_version >= "3.10"'] }],
    });
  });

  test("reports unsupported requirements directives instead of silently dropping them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-directive-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "-r base.txt\n--index-url https://example.invalid/simple\n");

    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({
      declared: 0,
      invalid: ["-r base.txt", "--index-url https://example.invalid/simple"],
      unresolved: [],
    });
  });

  test("sanitizes and bounds unsupported requirements diagnostics", () => {
    const parsed = parseRequirements(`--find-links https://example.invalid/\u202Ehidden\uD800\u0000${"x".repeat(300)}\n`);

    expect(parsed.invalid).toHaveLength(1);
    expect(parsed.invalid[0]).toHaveLength(256);
    expect(parsed.invalid[0]).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
    expect(parsed.invalid[0]).toMatch(/^--find-links https:\/\/example\.invalid\/ hidden /u);
  });

  test("does not create an unpaired surrogate when truncating requirements diagnostics", () => {
    const parsed = parseRequirements(`--${"x".repeat(253)}😀tail\n`);

    expect(parsed.invalid).toEqual([`--${"x".repeat(253)}😀`]);
    expect(parsed.invalid[0]).not.toMatch(/[\p{Cs}]/u);
  });

  test("checks dependencies relative to a nested package manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-nested-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "apps/example/node_modules/local-only"), { recursive: true });
    await writeFile(join(root, "apps/example/package.json"), JSON.stringify({ dependencies: { "local-only": "1.0.0" } }));

    await expect(inspectManifest(root, "apps/example/package.json")).resolves.toMatchObject({ installed: 1, missing: [] });
  });

  test("does not resolve malformed npm dependency names outside node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-name-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "outside-package"), { recursive: true });
    await mkdir(join(root, "node_modules", "valid-package"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "../outside-package": "1.0.0", "valid-package": "1.0.0" } }));

    await expect(inspectManifest(root)).resolves.toMatchObject({
      declared: 2,
      installed: 1,
      missing: [],
      invalid: ["../outside-package"],
    });
  });

  test("sanitizes and bounds invalid npm names without analyzing their constraints", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-invalid-npm-name-"));
    temporaryDirectories.push(root);
    const bidiName = "bad\u202Ename";
    const longName = `${"x".repeat(255)}😀tail`;
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { [bidiName]: "^1.0.0", [longName]: "^1.0.0" },
        devDependencies: { [bidiName]: "^2.0.0", [longName]: "workspace:*" },
      }),
    );

    const report = await inspectManifest(root);
    expect(report).toMatchObject({
      declared: 2,
      installed: 0,
      invalid: ["bad name", `${"x".repeat(255)}😀`],
      conflicts: [],
      unresolved: [],
    });
    expect(report.invalid.join("")).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
  });

  test("does not scan a virtualenv that escapes through a workspace symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-venv-root-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-dependency-checker-venv-outside-"));
    temporaryDirectories.push(root, outside);
    await writeFile(join(root, "requirements.txt"), "secret-pkg==1.0.0\n");
    await mkdir(join(outside, "lib/python3.12/site-packages/secret_pkg"), { recursive: true });
    await symlink(outside, join(root, ".venv"));

    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({
      declared: 1,
      installed: 0,
      missing: ["secret-pkg"],
    });
  });

  test("normalizes Python distribution names before checking site-packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-name-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "zope.interface==6.0\n");
    await mkdir(join(root, ".venv/lib/python3.12/site-packages/zope_interface-6.0.dist-info"), { recursive: true });

    expect(parseRequirements("zope.interface==6.0\n").names).toEqual(["zope-interface"]);
    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({ installed: 1, missing: [] });
  });

  test("does not treat a similarly prefixed Python package as the requested distribution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-prefix-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "requests==2.31.0\n");
    await mkdir(join(root, ".venv/lib/python3.12/site-packages/requests-malicious"), { recursive: true });

    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({ installed: 0, missing: ["requests"] });
  });

  test("recognizes exact Python module and metadata installation forms", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-forms-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "plain-pkg\nmodule-pkg\nnative-pkg\nwindows-pkg\nmetadata-pkg\nlegacy-pkg\nrequests\n");
    const sitePackages = join(root, ".venv/lib/python3.12/site-packages");
    await mkdir(join(sitePackages, "plain_pkg"), { recursive: true });
    await writeFile(join(sitePackages, "module_pkg.py"), "");
    await writeFile(join(sitePackages, "native_pkg.so"), "");
    await writeFile(join(sitePackages, "windows_pkg.pyd"), "");
    await mkdir(join(sitePackages, "metadata_pkg-2.0.dist-info"));
    await mkdir(join(sitePackages, "legacy_pkg-1.0.egg-info"));
    await mkdir(join(sitePackages, "requests-malicious"));

    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({
      declared: 7,
      installed: 6,
      missing: ["requests"],
    });
  });

  test("does not treat mismatched Python entry types or symlinks as installed packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-entry-types-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "plain-file\nfake-module\nlinked-package\n");
    const sitePackages = join(root, ".venv/lib/python3.12/site-packages");
    await mkdir(sitePackages, { recursive: true });
    await writeFile(join(sitePackages, "plain_file"), "");
    await mkdir(join(sitePackages, "fake_module.py"));
    await mkdir(join(root, "linked-target"));
    await symlink(join(root, "linked-target"), join(sitePackages, "linked_package"));

    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({
      declared: 3,
      installed: 0,
      missing: ["plain-file", "fake-module", "linked-package"],
    });
  });

  test("bounds Python environment directory scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-scan-limit-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "requests==2.31.0\n");
    const sitePackages = join(root, ".venv/lib/python3.12/site-packages");
    await mkdir(sitePackages, { recursive: true });
    await Promise.all(Array.from({ length: 4_097 }, (_, index) => writeFile(join(sitePackages, `noise-${index}.txt`), "")));

    await expect(inspectManifest(root, "requirements.txt")).rejects.toThrow(/Python environment exceeds.*4096-entry/iu);
  });

  test("checks a Windows virtualenv layout even when an empty Unix lib directory exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-windows-venv-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "flask==3.0.0\n");
    await mkdir(join(root, ".venv/lib"), { recursive: true });
    await mkdir(join(root, ".venv/Lib/site-packages/flask"), { recursive: true });

    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({ installed: 1, missing: [] });
  });

  test("rejects an oversized Python version constraint", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-constraint-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), `requests==${"1".repeat(4_097)}\n`);

    await expect(inspectManifest(root, "requirements.txt")).rejects.toThrow(/constraint.*4096/iu);
  });

  test("rejects an oversized Python distribution name", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-python-name-limit-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), `${"a".repeat(257)}==1.0.0\n`);

    await expect(inspectManifest(root, "requirements.txt")).rejects.toThrow(/name.*256/iu);
  });

  test.each([
    null,
    { manifest: 1 },
    { extra: true },
    { manifest: " package.json" },
    { manifest: "package.json " },
    { manifest: "bad\npackage.json" },
    { manifest: `${"😀".repeat(256)}.json` },
  ])("rejects malformed raw tool parameters %#", async (parameters) => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-params-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const { tool } = await setupPlugin(root);

    await expect(tool.execute("invalid", parameters as never, undefined, undefined, {} as never)).rejects.toThrow(/dependency check parameters/iu);
  });

  test("rejects accessor tool parameters without invoking them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-accessor-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const { tool } = await setupPlugin(root);
    let getterCalls = 0;
    const parameters = Object.defineProperty({}, "manifest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "package.json";
      },
    });

    await expect(tool.execute("accessor", parameters, undefined, undefined, {} as never)).rejects.toThrow(/dependency check parameters/iu);
    expect(getterCalls).toBe(0);
  });

  test("rejects revoked proxies and non-plain tool parameter objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-hostile-params-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const { tool } = await setupPlugin(root);
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    await expect(tool.execute("revoked", revocable.proxy, undefined, undefined, {} as never)).rejects.toThrow(/accessible plain object/iu);
    await expect(tool.execute("instance", new Date(), undefined, undefined, {} as never)).rejects.toThrow(/plain object/iu);
  });

  test("publishes a sequential tool with a closed parameter schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-tool-contract-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const { tools } = await setupPlugin(root);

    expect(tools.snapshot().customTools).toMatchObject([
      { name: "dependency_check", executionMode: "sequential", parameters: { additionalProperties: false } },
    ]);
  });

  test("honors a pre-cancelled caller signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-cancel-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const { tool } = await setupPlugin(root);
    const caller = new AbortController();
    caller.abort(new Error("cancelled by caller"));

    await expect(tool.execute("cancelled", {}, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled by caller/iu);
  });

  test("keeps panel state isolated from mutable tool results", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-state-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { missing: "1.0.0" } }));
    const { panels, tool } = await setupPlugin(root);
    const result = await tool.execute("inspect", {}, undefined, undefined, {} as never);
    (result.details as DependencyReport).missing[0] = "mutated";

    const panel = (await panels.snapshot())[0];
    expect(panel).toMatchObject({ id: "dependency-checker-panel", data: { report: { missing: ["missing"] } } });
  });

  test("accepts 2000 dependency declarations and rejects one over the scan limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-limit-"));
    temporaryDirectories.push(root);
    const dependencies = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`package-${index}`, "1.0.0"]));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies }));
    await mkdir(join(root, "node_modules"), { recursive: true });
    await Promise.all(Object.keys(dependencies).map((name) => mkdir(join(root, "node_modules", name))));

    await expect(inspectManifest(root)).resolves.toMatchObject({ declared: 2_000, installed: 2_000, scanLimit: 2_000 });

    dependencies["package-2000"] = "1.0.0";
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies }));
    await expect(inspectManifest(root)).rejects.toThrow(/2000-dependency scan limit/iu);
  });

  test("applies the npm scan limit to declarations across all dependency sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-declaration-limit-"));
    temporaryDirectories.push(root);
    const section = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`package-${index}`, "1.0.0"]));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: section, devDependencies: section, optionalDependencies: section, peerDependencies: section }),
    );

    await expect(inspectManifest(root)).rejects.toThrow(/2000-dependency scan limit/iu);
  });

  test.each([
    ["non-object section", { dependencies: [] }],
    ["non-string constraint", { dependencies: { react: { version: "19" } } }],
  ])("rejects an npm manifest with a %s", async (_label, manifest) => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-manifest-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));

    await expect(inspectManifest(root)).rejects.toThrow(/dependency section|constraint.*string/iu);
  });

  test("does not interpolate hostile npm keys into structural errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-hostile-npm-key-"));
    temporaryDirectories.push(root);
    const hostileName = "package\u202Ename";
    const manifests = [{ dependencies: { [hostileName]: { version: "1.0.0" } } }, { peerDependenciesMeta: { [hostileName]: { optional: "yes" } } }];

    for (const manifest of manifests) {
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));
      let failure: unknown;
      try {
        await inspectManifest(root);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(hostileName);
      expect((failure as Error).message).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
    }
  });

  test("rejects files that are not supported dependency manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-kind-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "private-config.json"), JSON.stringify({ dependencies: {} }));

    await expect(inspectManifest(root, "private-config.json")).rejects.toThrow(/package\.json or requirements.*\.txt/iu);
  });

  test("does not expose absolute workspace paths when a manifest cannot be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-missing-manifest-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const { tool } = await setupPlugin(root);

    let failure: unknown;
    try {
      await tool.execute("missing", { manifest: "missing/package.json" }, undefined, undefined, {} as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Could not resolve dependency manifest inside the current workspace");
    expect((failure as Error).message).not.toContain(root);
  });

  test("does not expose malformed JSON contents in parser errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-json-error-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), '{"privateTokenMarker": }');
    const { tool } = await setupPlugin(root);

    let failure: unknown;
    try {
      await tool.execute("invalid-json", {}, undefined, undefined, {} as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Invalid JSON dependency manifest");
    expect((failure as Error).message).not.toContain("privateTokenMarker");
    expect((failure as Error).message).not.toContain(root);
  });

  test("reports absent optional npm dependencies separately from required ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-optional-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { required: "1.0.0" }, optionalDependencies: { optional: "1.0.0" } }));

    await expect(inspectManifest(root)).resolves.toMatchObject({
      declared: 2,
      installed: 0,
      missing: ["required"],
      optionalMissing: ["optional"],
    });
    const { tool } = await setupPlugin(root);
    const result = await tool.execute("summary", {}, undefined, undefined, {} as never);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "package.json: 1 required missing, 1 optional missing, 0 invalid, 0 conflicts, 0 unresolved constraint groups.",
    });
  });

  test("reports a symbolic-link loop as an invalid npm installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-invalid-install-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { loop: "1.0.0" } }));
    await mkdir(join(root, "node_modules"));
    await symlink("loop", join(root, "node_modules", "loop"));

    await expect(inspectManifest(root)).resolves.toMatchObject({ installed: 0, missing: [], invalid: ["loop"] });
  });

  test("treats peerDependenciesMeta optional peers as optional missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-optional-peer-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ peerDependencies: { react: "^19.0.0" }, peerDependenciesMeta: { react: { optional: true } } }),
    );

    await expect(inspectManifest(root)).resolves.toMatchObject({ missing: [], optionalMissing: ["react"] });
  });

  test("cancels an in-flight check and unregisters its surfaces when disposed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-dispose-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const { context, panels, tool, tools } = await setupPlugin(root);
    const operation = tool.execute("dispose", {}, undefined, undefined, {} as never);
    const assertion = expect(operation).rejects.toThrow(/disposed/iu);

    contexts.splice(contexts.indexOf(context), 1);
    await context.fiber.dispose();

    await assertion;
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("rejects unknown configuration before registering surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-config-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    let failure: unknown;
    try {
      await context.plugin(dependencyCheckerPlugin, { unexpected: true });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/unknown.*unexpected/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("rolls back the tool when panel registration fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-panel-conflict-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    panels.register({ id: "dependency-checker-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });

    await expect(context.plugin(dependencyCheckerPlugin)).rejects.toThrow(/panel is already registered: dependency-checker-panel/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "dependency-checker-panel", pluginId: "fixture" }]);
  });
});
