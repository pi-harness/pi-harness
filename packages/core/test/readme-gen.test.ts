import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import readmeGenPlugin, { renderReadme, writeReadmeFile } from "../src/plugins/readme-gen.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const fixtures: { context: Context; root: string }[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async ({ context, root }) => {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function bareFixture(packageJson: unknown = { name: "demo", version: "1.2.3" }, loader?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-readme-plugin-"));
  const context = new Context();
  fixtures.push({ context, root });
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson), "utf8");
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  if (loader !== undefined) context.provide("loader", loader as never);
  return { context, panels, root, tools };
}

async function pluginFixture(packageJson: unknown = { name: "demo", version: "1.2.3" }, loader?: unknown) {
  const fixture = await bareFixture(packageJson, loader);
  const { context } = fixture;
  await context.plugin(readmeGenPlugin);
  return fixture;
}

describe("readme generator", () => {
  test("declares strict report and sequential confirmed-write contracts", async () => {
    const { tools } = await pluginFixture();
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    const write = tools.snapshot().customTools.find((tool) => tool.name === "readme_write");

    expect(readmeGenPlugin).toHaveProperty("Config");
    expect(report).toMatchObject({
      executionMode: "sequential",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    });
    expect(write).toMatchObject({
      executionMode: "sequential",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          outputPath: { type: "string", minLength: 1, maxLength: 512 },
          confirm: { type: "boolean" },
          overwrite: { type: "boolean" },
        },
      },
    });
  });

  test("rejects malformed raw parameters without invoking accessors", async () => {
    const { tools } = await pluginFixture();
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    const write = tools.snapshot().customTools.find((tool) => tool.name === "readme_write");
    if (report === undefined || write === undefined) throw new Error("README tools were not registered");
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "outputPath", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "README.md";
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    await expect(report.execute("primitive", null, undefined, undefined, {} as never)).rejects.toThrow(/README report parameters/iu);
    await expect(report.execute("extra", { extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
    await expect(report.execute("symbol", { [Symbol("extra")]: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
    await expect(write.execute("accessor", accessor as never, undefined, undefined, {} as never)).rejects.toThrow(/README write parameters/iu);
    await expect(write.execute("proxy", revocable.proxy, undefined, undefined, {} as never)).rejects.toThrow(/accessible plain object/iu);
    await expect(write.execute("confirm", { confirm: "true" }, undefined, undefined, {} as never)).rejects.toThrow(/confirm.*boolean/iu);
    expect(getterCalls).toBe(0);
  });

  test.each([{ unknown: true }, { [Symbol("unknown")]: true }])("rejects unknown empty-plugin config %# without registering tools", async (config) => {
    const { context, tools } = await bareFixture();

    expect(() => readmeGenPlugin.apply(context, config as never)).toThrow(/unknown.*config/iu);
    expect(tools.snapshot().customTools).toEqual([]);
  });

  test("renders scripts and active plugins as markdown", () => {
    expect(
      renderReadme({
        name: "demo",
        version: "1.2.3",
        description: "A demo project",
        scripts: ["build", "test"],
        plugins: ["@pi-harness/core/plugins/archify"],
      }),
    ).toBe(
      "# demo\n\nA demo project\n\nVersion: 1.2.3\n\n## Scripts\n\n- `npm run build`\n- `npm run test`\n\n## Runtime plugins\n\n- `@pi-harness/core/plugins/archify`\n",
    );
  });

  test("escapes manifest and plugin metadata as plain Markdown content", () => {
    const markdown = renderReadme({
      name: "demo\n## injected",
      version: "1.0_[draft]",
      description: "Text\n# heading <tag>",
      scripts: ["build` && injected"],
      plugins: ["plugin``name"],
    });

    expect(markdown).toContain("# demo \\#\\# injected");
    expect(markdown).not.toContain("\n## injected\n");
    expect(markdown).toContain("Version: 1.0\\_\\[draft\\]");
    expect(markdown).toContain("Text \\# heading \\<tag\\>");
    expect(markdown).toContain("- ``npm run build` && injected``");
    expect(markdown).toContain("- ```plugin``name```");
  });

  test.each([
    [{ name: 1 }, /package name.*string/iu],
    [{ name: "" }, /package name.*non-empty/iu],
    [{ name: " demo" }, /package name.*whitespace/iu],
    [{ name: "bad\u202Ename" }, /package name.*control/iu],
    [{ name: "x".repeat(257) }, /package name.*256/iu],
    [{ name: "😀".repeat(129) }, /package name.*UTF-8/iu],
    [{ version: 1 }, /package version.*string/iu],
    [{ version: "" }, /package version.*non-empty/iu],
    [{ version: "x".repeat(129) }, /package version.*128/iu],
    [{ description: 1 }, /package description.*string/iu],
    [{ description: "bad\ndescription" }, /package description.*control/iu],
    [{ description: "x".repeat(4_097) }, /package description.*4096/iu],
    [{ scripts: [] }, /package scripts.*object/iu],
    [{ scripts: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`script-${index}`, "true"])) }, /package scripts.*256/iu],
    [{ scripts: { "": "true" } }, /script name.*non-empty/iu],
    [{ scripts: { "bad\nscript": "true" } }, /script name.*control/iu],
    [{ scripts: { ["x".repeat(257)]: "true" } }, /script name.*256/iu],
  ] as const)("rejects malformed or unbounded package metadata %#", async (packageJson, expected) => {
    const { tools } = await pluginFixture(packageJson);
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (report === undefined) throw new Error("readme_report was not registered");

    await expect(report.execute("invalid-manifest", {}, undefined, undefined, {} as never)).rejects.toThrow(expected);
  });

  test("returns a stable public error for invalid package JSON", async () => {
    const { root, tools } = await pluginFixture();
    await writeFile(join(root, "package.json"), '{"name":', "utf8");
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (report === undefined) throw new Error("readme_report was not registered");

    const error = await report.execute("invalid-json", {}, undefined, undefined, {} as never).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid package.json");
  });

  test("does not expose the workspace path when package.json cannot be read", async () => {
    const { root, tools } = await pluginFixture();
    await rm(join(root, "package.json"));
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (report === undefined) throw new Error("readme_report was not registered");

    const error = await report.execute("missing-manifest", {}, undefined, undefined, {} as never).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Could not read package.json");
    expect((error as Error).message).not.toContain(root);
  });

  test("reads loader entries through data descriptors without invoking hostile getters and de-duplicates plugins", async () => {
    let getterCalls = 0;
    const hostileDisabled = Object.defineProperty({ options: { name: "plugin-a" } }, "disabled", {
      get() {
        getterCalls += 1;
        throw new Error("disabled getter executed");
      },
    });
    const hostileOptions = Object.defineProperty({}, "options", {
      get() {
        getterCalls += 1;
        return { name: "plugin-b" };
      },
    });
    const loader = {
      *entries() {
        yield hostileDisabled;
        yield { options: { name: "plugin-a" } };
        yield { fiber: undefined, options: { name: "disabled-by-parent" } };
        yield { fiber: {}, options: { name: "plugin-active" } };
        yield { options: { name: "cordis:internal" } };
      },
    };
    const { tools } = await pluginFixture({ name: "demo" }, loader);
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (report === undefined) throw new Error("readme_report was not registered");

    await expect(report.execute("safe-loader", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { plugins: ["plugin-a", "plugin-active"] },
    });
    expect(getterCalls).toBe(0);

    const { tools: hostileTools } = await pluginFixture({ name: "demo" }, { entries: () => [hostileOptions] });
    const hostileReport = hostileTools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (hostileReport === undefined) throw new Error("readme_report was not registered");
    await expect(hostileReport.execute("hostile-loader", {}, undefined, undefined, {} as never)).rejects.toThrow(/loader entry.*data property/iu);
    expect(getterCalls).toBe(0);
  });

  test.each([
    [[{ options: { name: "x".repeat(257) } }], /plugin name.*256/iu],
    [[{ options: { name: "😀".repeat(129) } }], /plugin name.*UTF-8/iu],
    [[{ options: { name: "bad\nplugin" } }], /plugin name.*control/iu],
    [Array.from({ length: 257 }, (_, index) => ({ options: { name: `plugin-${index}` } })), /256 unique/iu],
    [Array.from({ length: 1_025 }, (_, index) => ({ options: { name: `cordis:${index}` } })), /1024 entries/iu],
  ] as const)("bounds loader inventory %#", async (entries, expected) => {
    const { tools } = await pluginFixture({ name: "demo" }, { entries: () => entries });
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (report === undefined) throw new Error("readme_report was not registered");

    await expect(report.execute("bounded-loader", {}, undefined, undefined, {} as never)).rejects.toThrow(expected);
  });

  test("does not invoke loader iterator or iterator-result accessors", async () => {
    let getterCalls = 0;
    const hostileIterator = {
      [Symbol.iterator]() {
        return this;
      },
    };
    Object.defineProperty(hostileIterator, "next", {
      get() {
        getterCalls += 1;
        throw new Error("next getter executed");
      },
    });
    const first = await pluginFixture({ name: "demo" }, { entries: () => hostileIterator });
    const firstReport = first.tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (firstReport === undefined) throw new Error("readme_report was not registered");
    await expect(firstReport.execute("hostile-next", {}, undefined, undefined, {} as never)).rejects.toThrow(
      /iterator.*(?:data method|descriptor-accessible)/iu,
    );

    const hostileStep = Object.defineProperty({}, "done", {
      get() {
        getterCalls += 1;
        return true;
      },
    });
    const second = await pluginFixture(
      { name: "demo" },
      {
        entries: () => ({
          [Symbol.iterator]() {
            return this;
          },
          next() {
            return hostileStep;
          },
        }),
      },
    );
    const secondReport = second.tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (secondReport === undefined) throw new Error("readme_report was not registered");
    await expect(secondReport.execute("hostile-step", {}, undefined, undefined, {} as never)).rejects.toThrow(/iterator result.*data properties/iu);
    expect(getterCalls).toBe(0);
  });

  test("requires confirmation and writes inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-readme-"));
    try {
      await expect(writeReadmeFile(root, "# Demo\n", "README.generated.md", false)).rejects.toThrow(/confirm=true/);
      await expect(writeReadmeFile(root, "# Demo\n", "../outside.md", true)).rejects.toThrow(/inside the workspace/);
      await expect(writeReadmeFile(root, "# Demo\n", "docs/README.generated.md", true)).resolves.toMatchObject({
        path: "docs/README.generated.md",
        bytes: 7,
        overwritten: false,
      });
      await expect(readFile(join(root, "docs/README.generated.md"), "utf8")).resolves.toBe("# Demo\n");
      const outside = await mkdtemp(join(tmpdir(), "pi-harness-readme-outside-"));
      try {
        await writeFile(join(outside, "README.md"), "outside\n", "utf8");
        await symlink(join(outside, "README.md"), join(root, "README.link.md"));
        await expect(writeReadmeFile(root, "# Demo\n", "README.link.md", true)).rejects.toThrow(/symbolic link/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["", /non-empty/iu],
    [" README.md", /whitespace/iu],
    ["README.md ", /whitespace/iu],
    ["docs/./README.md", /path segments/iu],
    ["docs/../README.md", /path segments/iu],
    ["docs//README.md", /path segments/iu],
    ["docs\\README.md", /relative POSIX/iu],
    ["/tmp/README.md", /relative POSIX/iu],
    ["C:\\tmp\\README.md", /relative POSIX/iu],
    ["bad\nREADME.md", /control/iu],
    [`${"😀".repeat(129)}/README.md`, /UTF-8 bytes/iu],
    ["docs/project.md", /README Markdown/iu],
    ["package.json", /README Markdown/iu],
  ])("rejects unsafe README output path %#", async (path, expected) => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-readme-path-"));
    try {
      await expect(writeReadmeFile(root, "# Demo\n", path, true)).rejects.toThrow(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires an explicit overwrite confirmation for an existing README", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-readme-overwrite-"));
    try {
      const path = join(root, "README.md");
      await writeFile(path, "original\n", "utf8");

      await expect(writeReadmeFile(root, "replacement\n", "README.md", true, false)).rejects.toThrow(/overwrite=true/iu);
      await expect(readFile(path, "utf8")).resolves.toBe("original\n");
      await expect(writeReadmeFile(root, "replacement\n", "README.md", true, true)).resolves.toMatchObject({
        path: "README.md",
        overwritten: true,
      });
      await expect(readFile(path, "utf8")).resolves.toBe("replacement\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the permissions of a README it regenerates and creates a new one owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-readme-mode-"));
    try {
      const path = join(root, "README.md");
      await writeFile(path, "original\n", "utf8");
      await chmod(path, 0o644);

      await writeReadmeFile(root, "replacement\n", "README.md", true, true);
      await expect(stat(path).then((info) => info.mode & 0o777)).resolves.toBe(0o644);

      await writeReadmeFile(root, "# Fresh\n", "docs/README.md", true);
      await expect(stat(join(root, "docs/README.md")).then((info) => info.mode & 0o777)).resolves.toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose absolute paths from unexpected write filesystem errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-readme-write-error-"));
    const missingRoot = join(root, "missing-workspace");
    try {
      const error = await writeReadmeFile(missingRoot, "# Demo\n", "README.md", true).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Could not write README inside the workspace");
      expect((error as Error).message).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symbolic-link parent directories even when they currently resolve inside the workspace", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-readme-parent-link-"));
    try {
      const realDocs = join(root, "real-docs");
      await mkdir(realDocs);
      await symlink(realDocs, join(root, "docs"), "dir");

      await expect(writeReadmeFile(root, "# Demo\n", "docs/README.md", true)).rejects.toThrow(/parent.*symbolic link/iu);
      await expect(readFile(join(realDocs, "README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("regenerates from the current manifest immediately before writing", async () => {
    const { root, tools } = await pluginFixture({ name: "before", version: "1.0.0" });
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    const write = tools.snapshot().customTools.find((tool) => tool.name === "readme_write");
    if (report === undefined || write === undefined) throw new Error("README tools were not registered");
    await report.execute("initial", {}, undefined, undefined, {} as never);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "after", version: "2.0.0" }), "utf8");

    await write.execute("write-current", { confirm: true }, undefined, undefined, {} as never);

    await expect(readFile(join(root, "README.generated.md"), "utf8")).resolves.toContain("# after");
  });

  test("honors caller cancellation and plugin disposal before filesystem work", async () => {
    const callerFixture = await pluginFixture();
    const report = callerFixture.tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    if (report === undefined) throw new Error("readme_report was not registered");
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled README generation"));

    await expect(report.execute("cancelled", {}, controller.signal, undefined, {} as never)).rejects.toThrow(/caller cancelled/iu);
    await expect(callerFixture.panels.snapshot()).resolves.toMatchObject([{ data: { status: { state: "cancelled", operation: "report" } } }]);

    const disposedFixture = await pluginFixture();
    const write = disposedFixture.tools.snapshot().customTools.find((tool) => tool.name === "readme_write");
    if (write === undefined) throw new Error("readme_write was not registered");
    await disposedFixture.context.fiber.dispose();
    await expect(write.execute("disposed", { confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    await expect(readFile(join(disposedFixture.root, "README.generated.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps detached last-success snapshots visible when a later attempt fails", async () => {
    const { panels, root, tools } = await pluginFixture({ name: "stable", version: "1.0.0", scripts: { build: "tsc" } });
    const report = tools.snapshot().customTools.find((tool) => tool.name === "readme_report");
    const write = tools.snapshot().customTools.find((tool) => tool.name === "readme_write");
    if (report === undefined || write === undefined) throw new Error("README tools were not registered");

    const generated = await report.execute("report", {}, undefined, undefined, {} as never);
    const generatedDetails = generated.details as { name: string; scripts: string[] };
    generatedDetails.name = "mutated";
    generatedDetails.scripts.push("mutated");
    const written = await write.execute("write", { confirm: true }, undefined, undefined, {} as never);
    const writeDetails = written.details as { path: string; bytes: number };
    writeDetails.path = "README.mutated.md";
    writeDetails.bytes = 0;
    await writeFile(join(root, "package.json"), '{"name":', "utf8");
    await expect(report.execute("failed", {}, undefined, undefined, {} as never)).rejects.toThrow("Invalid package.json");

    const snapshot = await panels.snapshot();
    expect(snapshot).toMatchObject([
      {
        data: {
          generated: true,
          name: "stable",
          scripts: 1,
          lastWrite: { path: "README.generated.md", overwritten: false },
          status: { state: "failed", operation: "report", error: "Invalid package.json" },
        },
      },
    ]);
    expect(typeof (snapshot[0]?.data as { lastWrite?: { bytes?: unknown } } | undefined)?.lastWrite?.bytes).toBe("number");
  });

  test("rolls back registered tools when panel registration fails", async () => {
    const { context, panels, tools } = await bareFixture();
    panels.register({
      id: "readme-gen-panel",
      pluginId: "fixture",
      title: "Existing panel",
      read: () => ({}),
    });

    expect(() => readmeGenPlugin.apply(context, {})).toThrow(/already registered/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ pluginId: "fixture", title: "Existing panel" }]);
  });
});
