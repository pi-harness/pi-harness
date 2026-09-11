import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { bootHarness, type BootedHarness } from "../src/boot.js";

const booted: BootedHarness[] = [];
const consoleLoggerEntry = import.meta.resolve("@deepseek-ai/cordis-plugin-logger-console");

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (harness) => harness.dispose()));
  vi.restoreAllMocks();
});

async function createProfile(entries: unknown[]): Promise<{ directory: string; profilePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-harness-boot-"));
  const profilePath = join(directory, "cordis.yml");
  await writeFile(profilePath, JSON.stringify(entries), "utf8");
  return { directory, profilePath };
}

async function createPlugin(directory: string, name: string, source: string): Promise<string> {
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, source, "utf8");
  return pathToFileURL(path).href;
}

describe("bootHarness", () => {
  test.each(["profile", "group", "include", "dynamic"])("resolves distribution plugins from the launcher anchor (%s)", async (location) => {
    const profile = await createProfile([]);
    const distribution = join(profile.directory, "distribution");
    const packageDirectory = join(distribution, "node_modules", "pih-launcher-only-fixture");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ type: "module", exports: { import: "./index.js" } }));
    await writeFile(join(packageDirectory, "index.js"), 'export default function(ctx) { ctx.provide("fixtureDistribution", "launcher"); }');
    const entry = { id: "distribution-fixture", name: "pih-launcher-only-fixture" };
    const nestedProfile = join(profile.directory, "nested.json");
    await writeFile(nestedProfile, JSON.stringify([entry]));
    const entries =
      location === "dynamic"
        ? []
        : location === "group"
          ? [{ name: "cordis:group", group: true, config: [entry] }]
          : location === "include"
            ? [{ name: "cordis:include", config: { path: pathToFileURL(nestedProfile).href } }]
            : [entry];
    await writeFile(profile.profilePath, JSON.stringify(entries));
    let harness: BootedHarness | undefined;
    try {
      const options = { configPath: profile.profilePath, pluginResolutionAnchor: join(distribution, "bin.js") };
      harness = await bootHarness(options);
      if (location === "dynamic") await harness.context.loader.create(entry);
      expect(harness.context.get("fixtureDistribution")).toBe("launcher");
      expect(await readFile(profile.profilePath, "utf8")).toBe(JSON.stringify(entries));
      expect(await readFile(nestedProfile, "utf8")).toBe(JSON.stringify([entry]));
    } finally {
      await harness?.dispose();
      await rm(profile.directory, { recursive: true, force: true });
    }
  });

  test("keeps profile-installed plugins ahead of the launcher fallback", async () => {
    const profile = await createProfile([{ name: "pih-resolution-priority-fixture" }]);
    const distribution = join(profile.directory, "distribution");
    for (const [root, value] of [
      [profile.directory, "profile"],
      [distribution, "launcher"],
    ] as const) {
      const packageDirectory = join(root, "node_modules", "pih-resolution-priority-fixture");
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ type: "module", exports: { import: "./index.js" } }));
      await writeFile(join(packageDirectory, "index.js"), `export default function(ctx) { ctx.provide("fixturePriority", ${JSON.stringify(value)}); }`);
    }
    let harness: BootedHarness | undefined;
    try {
      const options = { configPath: profile.profilePath, pluginResolutionAnchor: join(distribution, "bin.js") };
      harness = await bootHarness(options);
      expect(harness.context.get("fixturePriority")).toBe("profile");
    } finally {
      await harness?.dispose();
      await rm(profile.directory, { recursive: true, force: true });
    }
  });

  test.each(["profile", "launcher"])("preserves internal-loader import conditions for dual-entry plugins (%s)", async (location) => {
    const profile = await createProfile([{ name: "pih-dual-entry-fixture" }]);
    const distribution = join(profile.directory, "distribution");
    const packageDirectory = join(location === "profile" ? profile.directory : distribution, "node_modules", "pih-dual-entry-fixture");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ type: "module", exports: { import: "./import.js?generation=2#instance", require: "./require.cjs" } }),
    );
    await writeFile(
      join(packageDirectory, "import.js"),
      'export default function(ctx) { ctx.provide("fixtureEntryCondition", "import"); ctx.provide("fixtureEntryUrl", import.meta.url); }',
    );
    await writeFile(join(packageDirectory, "require.cjs"), 'module.exports = function(ctx) { ctx.provide("fixtureEntryCondition", "require"); };');
    let harness: BootedHarness | undefined;
    try {
      harness = await bootHarness({
        configPath: profile.profilePath,
        pluginResolutionAnchor: join(distribution, "bin.js"),
        prepare(context) {
          expect(context.loader.internal).toBeDefined();
        },
      });
      expect(harness.context.get("fixtureEntryCondition")).toBe("import");
      expect(harness.context.get("fixtureEntryUrl")).toContain("?generation=2#instance");
    } finally {
      await harness?.dispose();
      await rm(profile.directory, { recursive: true, force: true });
    }
  });

  test("does not hide a broken profile package behind the launcher fallback", async () => {
    const profile = await createProfile([{ name: "pih-broken-entry-fixture" }]);
    const distribution = join(profile.directory, "distribution");
    for (const root of [profile.directory, distribution]) {
      const packageDirectory = join(root, "node_modules", "pih-broken-entry-fixture");
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ type: "module", exports: { import: "./entry.js" } }));
      if (root === distribution) await writeFile(join(packageDirectory, "entry.js"), "export default function() {}");
    }
    try {
      await expect(bootHarness({ configPath: profile.profilePath, pluginResolutionAnchor: join(distribution, "bin.js") })).rejects.toThrow(
        /Cannot find module.*entry\.js/u,
      );
    } finally {
      await rm(profile.directory, { recursive: true, force: true });
    }
  });

  test("loads a profile and activates its plugin", async () => {
    const profile = await createProfile([]);
    const plugin = await createPlugin(
      profile.directory,
      "provider",
      `export default function provider(ctx, config) { ctx.provide("fixtureValue", config.value); }`,
    );
    await writeFile(profile.profilePath, JSON.stringify([{ name: plugin, config: { value: "active" } }]), "utf8");

    const harness = await bootHarness({ configPath: profile.profilePath });
    booted.push(harness);

    expect(harness.context.get("fixtureValue")).toBe("active");
  });

  test("fails loudly when a plugin module cannot be resolved", async () => {
    const profile = await createProfile([{ name: "./missing-plugin.mjs" }]);

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/missing-plugin\.mjs/);
  });

  test("reports plugins left pending by unresolved injections", async () => {
    const profile = await createProfile([]);
    const plugin = await createPlugin(profile.directory, "consumer", `export default { inject: ["serviceThatDoesNotExist"], apply() {} };`);
    await writeFile(profile.profilePath, JSON.stringify([{ name: plugin }]), "utf8");

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/serviceThatDoesNotExist/);
  });

  test("disposes already-active plugins when a later activation fails", async () => {
    const profile = await createProfile([]);
    const markerPath = join(profile.directory, "lifecycle.txt");
    const owner = await createPlugin(
      profile.directory,
      "owner",
      `import { appendFileSync, writeFileSync } from "node:fs"; export default function owner(ctx, config) { writeFileSync(config.markerPath, "started"); ctx.provide("fixtureOwnerReady", true); ctx.effect(() => () => appendFileSync(config.markerPath, ":disposed")); }`,
    );
    const failure = await createPlugin(
      profile.directory,
      "failure",
      `export default { inject: ["fixtureOwnerReady"], apply() { throw new Error("fixture activation failed"); } };`,
    );
    await writeFile(profile.profilePath, JSON.stringify([{ name: owner, config: { markerPath } }, { name: failure }]), "utf8");

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/fixture activation failed/);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("started:disposed");
  });

  test("does not rewrite a profile when a nested group rolls back", async () => {
    const profile = await createProfile([]);
    const active = await createPlugin(profile.directory, "active", `export default function active(ctx) { ctx.provide("fixtureNestedReady", true); }`);
    const failure = await createPlugin(
      profile.directory,
      "nested-failure",
      `export default { inject: ["fixtureNestedReady"], apply() { throw new Error("nested activation failed"); } };`,
    );
    const source = JSON.stringify([
      {
        id: "fixture-group",
        name: "cordis:group",
        group: true,
        config: [
          { id: "active", name: active },
          { id: "nested-failure", name: failure },
        ],
      },
    ]);
    await writeFile(profile.profilePath, source, "utf8");

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/nested activation failed/);

    await expect(readFile(profile.profilePath, "utf8")).resolves.toBe(source);
  });

  test("reports an activation failure as a message and keeps the stack frames behind PI_HARNESS_DEBUG", async () => {
    const profile = await createProfile([]);
    const failure = await createPlugin(profile.directory, "stack-failure", `export default { apply() { throw new Error("fixture stack failed"); } };`);
    await writeFile(profile.profilePath, JSON.stringify([{ name: failure }]), "utf8");

    const quiet = await bootHarness({ configPath: profile.profilePath }).catch((error: unknown) => error);
    let verbose: unknown;
    try {
      vi.stubEnv("PI_HARNESS_DEBUG", "1");
      verbose = await bootHarness({ configPath: profile.profilePath }).catch((error: unknown) => error);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(quiet).toBeInstanceOf(Error);
    expect((quiet as Error).message).toContain("fixture stack failed");
    expect((quiet as Error).message).not.toMatch(/^\s+at /mu);
    expect((verbose as Error).message).toContain("fixture stack failed");
    expect((verbose as Error).message).toMatch(/^\s+at /mu);
  });

  test("says a repeated cause once, since the loader quotes the message it caught in its own", async () => {
    const profile = await createProfile([]);
    await writeFile(profile.profilePath, JSON.stringify([{ name: "@pi-harness/plugin-absent-fixture" }]), "utf8");

    const error = (await bootHarness({ configPath: profile.profilePath }).catch((failure: unknown) => failure)) as Error;

    expect(error.message).toContain("@pi-harness/plugin-absent-fixture");
    expect(error.message.split("\n").filter((line) => line.startsWith("caused by: "))).toEqual([]);
  });

  test("rejects a duplicate entry id reused across sibling groups", async () => {
    const profile = await createProfile([]);
    const first = await createPlugin(
      profile.directory,
      "first",
      `export default function first(ctx, config) { ctx.provide("fixtureDuplicate", config?.tag ?? "no-config"); }`,
    );
    const second = await createPlugin(profile.directory, "second", `export default function second(ctx) { ctx.provide("fixtureDuplicateSecond", true); }`);
    await writeFile(
      profile.profilePath,
      JSON.stringify([
        { id: "one", name: "cordis:group", group: true, config: [{ id: "shared", name: first, config: { tag: "kept" } }] },
        { id: "two", name: "cordis:group", group: true, config: [{ id: "shared", name: second }] },
      ]),
      "utf8",
    );

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/Duplicate loader entry id "shared"/);
  });

  test("accepts exactly 512 disabled profile entries and rejects the next one", async () => {
    const exact = await createProfile(Array.from({ length: 512 }, (_, index) => ({ id: `entry-${index}`, name: "./disabled-fixture.mjs", disabled: true })));
    const harness = await bootHarness({ configPath: exact.profilePath });
    booted.push(harness);

    const oversized = await createProfile(
      Array.from({ length: 513 }, (_, index) => ({ id: `entry-${index}`, name: "./disabled-fixture.mjs", disabled: true })),
    );
    await expect(bootHarness({ configPath: oversized.profilePath })).rejects.toThrow(/512-entry limit/iu);
  });

  test("accepts 16 nested groups and rejects a seventeenth level", async () => {
    const nested = (depth: number): unknown[] => {
      let entry: Record<string, unknown> = { id: "leaf", name: "./disabled-fixture.mjs", disabled: true };
      for (let index = 0; index < depth; index += 1) {
        entry = { id: `group-${index}`, name: "cordis:group", group: true, config: [entry] };
      }
      return [entry];
    };
    const exact = await createProfile(nested(16));
    const harness = await bootHarness({ configPath: exact.profilePath });
    booted.push(harness);

    const tooDeep = await createProfile(nested(17));
    await expect(bootHarness({ configPath: tooDeep.profilePath })).rejects.toThrow(/16-level nesting limit/iu);
  });

  test("rejects malformed group entries before the external plugin runs", async () => {
    const malformedGroup = await createProfile([{ id: "group", name: "cordis:group", group: true, config: {} }]);
    await expect(bootHarness({ configPath: malformedGroup.profilePath })).rejects.toThrow(/group config must be an array/iu);

    const malformedName = await createProfile([{ id: "entry", name: 7, disabled: true }]);
    await expect(bootHarness({ configPath: malformedName.profilePath })).rejects.toThrow(/plugin name must be a non-empty string/iu);

    const oversizedId = await createProfile([{ id: "x".repeat(129), name: "./disabled-fixture.mjs", disabled: true }]);
    await expect(bootHarness({ configPath: oversizedId.profilePath })).rejects.toThrow(/entry id.*128/iu);
  });

  test("makes the console logger emit warnings with its safe default profile", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const profile = await createProfile([{ id: "logger", name: consoleLoggerEntry, config: {} }]);
    const harness = await bootHarness({ configPath: profile.profilePath });
    booted.push(harness);
    output.mockClear();

    harness.context.logger("audit").warn("warning diagnostic");

    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]?.[0]).toContain("warning diagnostic");
  });

  test("retains warnings and debug diagnostics in the bounded logger buffer", async () => {
    const profile = await createProfile([]);
    const harness = await bootHarness({ configPath: profile.profilePath });
    booted.push(harness);
    harness.context.logger.buffer = [];

    const logger = harness.context.logger("audit");
    logger.warn("warning diagnostic");
    logger.debug("debug diagnostic");

    expect(harness.context.logger.buffer.map((message) => message.type)).toEqual(["warn", "debug"]);
  });

  test("disposes the console logger without removing a later exporter", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const profile = await createProfile([]);
    const collector = await createPlugin(
      profile.directory,
      "collector",
      `export default function collector(ctx) {
        const messages = [];
        ctx.provide("fixtureLoggerMessages", messages);
        ctx.logger.exporter({ levels: { default: 3 }, export(message) { messages.push(message.args[0]); } });
      }`,
    );
    await writeFile(
      profile.profilePath,
      JSON.stringify([
        { id: "logger", name: consoleLoggerEntry, config: {} },
        { id: "collector", name: collector },
      ]),
      "utf8",
    );
    const harness = await bootHarness({ configPath: profile.profilePath });
    booted.push(harness);
    const messages = harness.context.get("fixtureLoggerMessages") as string[];
    messages.length = 0;
    output.mockClear();

    const entry = [...harness.context.loader.entries()].find((item) => item.options.id === "logger");
    await entry?.update({ disabled: true });
    harness.context.logger("audit").info("after logger disposal");

    expect(messages).toEqual(["after logger disposal"]);
    expect(output).not.toHaveBeenCalled();
  });

  test.each([
    ["non-object config", []],
    ["unknown option", { destination: "remote" }],
    ["color level", { colors: 4 }],
    ["line length", { maxLength: 0 }],
    ["oversized line length", { maxLength: 65_537 }],
    ["levels map", { levels: [] }],
    ["levels count", { levels: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`logger-${index}`, 1])) }],
    ["empty logger name", { levels: { "": 1 } }],
    ["oversized logger name", { levels: { ["x".repeat(129)]: 1 } }],
    ["logger level", { levels: { default: 4 } }],
    ["diff flag", { showDiff: "yes" }],
    ["timestamp template", { showTime: "x".repeat(65) }],
    ["label object", { label: [] }],
    ["unknown label option", { label: { color: "red" } }],
    ["label width", { label: { width: 257 } }],
    ["label margin", { label: { margin: -1 } }],
    ["label alignment", { label: { align: "center" } }],
  ])("rejects unsafe console logger %s before activation", async (_label, config) => {
    const profile = await createProfile([{ id: "logger", name: consoleLoggerEntry, config }]);

    await expect(
      bootHarness({ configPath: profile.profilePath }).then((harness) => {
        booted.push(harness);
      }),
    ).rejects.toThrow(/console logger config/iu);
  });

  test("forwards Cordis full-reload requests to the host", async () => {
    const profile = await createProfile([]);
    let reloads = 0;
    const harness = await bootHarness({
      configPath: profile.profilePath,
      onFullReload() {
        reloads += 1;
      },
    });
    booted.push(harness);

    harness.context.loader.exit();

    expect(reloads).toBe(1);
  });
});
