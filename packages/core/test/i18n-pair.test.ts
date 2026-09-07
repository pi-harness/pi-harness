import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import i18nPairPlugin, { Config } from "../src/plugins/i18n-pair.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-i18n-pair-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-i18n-pair-agent-"));
  temporaryDirectories.push(cwd, agentDir);
  await mkdir(join(cwd, "locales"), { recursive: true });
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(i18nPairPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "i18n_check");
  if (tool === undefined) throw new Error("i18n_check was not registered");
  return { context, cwd, tools, panels, tool };
}

async function writeLocales(cwd: string, base: unknown, target: unknown): Promise<void> {
  await Promise.all([
    writeFile(join(cwd, "locales", "en.json"), JSON.stringify(base), "utf8"),
    writeFile(join(cwd, "locales", "zh-CN.json"), JSON.stringify(target), "utf8"),
  ]);
}

describe("i18n pair production boundaries", () => {
  test("exports a strict empty config and a sequential strict-schema tool", async () => {
    expect(Config).toBeDefined();
    const fixture = await createFixture();
    try {
      expect(fixture.tool).toMatchObject({
        name: "i18n_check",
        executionMode: "sequential",
        parameters: {
          additionalProperties: false,
          properties: {
            base: { type: "string", minLength: 1, maxLength: 4_096 },
            target: { type: "string", minLength: 1, maxLength: 4_096 },
          },
        },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects unknown configuration before registering surfaces", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-i18n-pair-config-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-i18n-pair-agent-"));
    temporaryDirectories.push(cwd, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      let failure: unknown;
      try {
        await context.plugin(i18nPairPlugin, { unexpected: true });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/unknown.*unexpected/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);

      let getterCalls = 0;
      const accessorConfig = Object.defineProperty({}, "unexpected", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return true;
        },
      });
      const symbolConfig = { [Symbol("unexpected")]: true };
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      for (const config of ["invalid", accessorConfig, symbolConfig, revocable.proxy]) {
        expect(() => i18nPairPlugin.apply(context, config as never)).toThrow(
          /(?:config.*(?:plain object|data properties|unknown|accessible)|unknown.*config)/iu,
        );
      }
      expect(getterCalls).toBe(0);
      expect(tools.snapshot().customTools).toEqual([]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rolls back tool registration when the panel id is unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-i18n-pair-conflict-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-i18n-pair-agent-"));
    temporaryDirectories.push(cwd, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    panels.register({ id: "i18n-pair-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
    try {
      await expect(context.plugin(i18nPairPlugin)).rejects.toThrow(/already registered.*i18n-pair-panel/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "i18n-pair-panel", pluginId: "fixture" }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("compares literal dotted and empty keys without colliding with nested paths", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, { a: { b: "nested" }, "a.b": "literal", "": "empty" }, { a: { b: "nested" } });
    try {
      await expect(fixture.tool.execute("paths", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { baseKeys: 3, targetKeys: 1, missing: ['[""]', '["a.b"]'], extra: [] },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects locale roots that are not JSON objects", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, ["not", "an", "object"], {});
    try {
      await expect(fixture.tool.execute("array-root", {}, undefined, undefined, {} as never)).rejects.toThrow(/locale root.*object/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects invalid UTF-8 instead of comparing replacement characters", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.cwd, "locales", "en.json"), Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x3a, 0x31, 0x7d]));
    await writeFile(join(fixture.cwd, "locales", "zh-CN.json"), "{}", "utf8");
    try {
      await expect(fixture.tool.execute("utf8", {}, undefined, undefined, {} as never)).rejects.toThrow(/UTF-8/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("strictly validates raw parameters without invoking accessors", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, {}, {});
    let accessed = false;
    const accessor = { target: "locales/zh-CN.json" } as { base?: string; target: string };
    Object.defineProperty(accessor, "base", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("locale accessor executed");
      },
    });
    try {
      await expect(fixture.tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(fixture.tool.execute("unknown", { base: "locales/en.json", extra: true }, undefined, undefined, {} as never)).rejects.toThrow(
        /unknown property/iu,
      );
      await expect(fixture.tool.execute("type", { base: 42 }, undefined, undefined, {} as never)).rejects.toThrow(/base.*string/iu);
      await expect(fixture.tool.execute("null", { base: null }, undefined, undefined, {} as never)).rejects.toThrow(/base.*string/iu);
      await expect(fixture.tool.execute("nul", { base: "locales/en.json\0" }, undefined, undefined, {} as never)).rejects.toThrow(/base.*NUL/iu);

      const inherited = Object.create({ base: "locales/en.json" }) as Record<string, unknown>;
      await expect(fixture.tool.execute("inherited", inherited, undefined, undefined, {} as never)).rejects.toThrow(/plain object/iu);
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      await expect(fixture.tool.execute("revoked", revocable.proxy, undefined, undefined, {} as never)).rejects.toThrow(/accessible plain object/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("accepts only bounded relative display-safe locale paths", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, {}, {});
    try {
      await expect(fixture.tool.execute("absolute", { base: resolve(fixture.cwd, "locales/en.json") }, undefined, undefined, {} as never)).rejects.toThrow(
        /relative.*workspace/iu,
      );
      await expect(fixture.tool.execute("leading", { base: " locales/en.json" }, undefined, undefined, {} as never)).rejects.toThrow(/whitespace/iu);
      await expect(fixture.tool.execute("control", { base: "locales/\u202e.json" }, undefined, undefined, {} as never)).rejects.toThrow(/control/iu);
      await expect(fixture.tool.execute("bytes", { base: `locales/${"界".repeat(1_364)}.json` }, undefined, undefined, {} as never)).rejects.toThrow(
        /UTF-8 bytes/iu,
      );
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects final-file symbolic links even when their targets stay inside the workspace", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, { greeting: "Hello" }, { greeting: "你好" });
    await symlink("en.json", join(fixture.cwd, "locales", "linked.json"));
    try {
      await expect(fixture.tool.execute("symlink", { base: "locales/linked.json" }, undefined, undefined, {} as never)).rejects.toThrow(/symbolic link/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("stabilizes file and parser failures without leaking absolute workspace paths", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, {}, {});
    try {
      const missing = await fixture.tool
        .execute("missing", { base: "locales/missing.json" }, undefined, undefined, {} as never)
        .catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(Error);
      expect((missing as Error).message).toMatch(/could not resolve locale file/iu);
      expect((missing as Error).message).not.toContain(fixture.cwd);

      await writeFile(join(fixture.cwd, "locales", "en.json"), '{"private-value":', "utf8");
      const malformed = await fixture.tool.execute("malformed", {}, undefined, undefined, {} as never).catch((error: unknown) => error);
      expect(malformed).toBeInstanceOf(Error);
      expect((malformed as Error).message).toBe("Invalid locale JSON");
      expect((malformed as Error).message).not.toContain("private-value");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects flattened keys that exceed the UTF-8 byte limit or contain control characters", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, { ["界".repeat(700)]: "value" }, {});
    try {
      await expect(fixture.tool.execute("key-bytes", {}, undefined, undefined, {} as never)).rejects.toThrow(/flattened keys.*UTF-8 bytes/iu);
      await writeLocales(fixture.cwd, { ["safe\u202eunsafe"]: "value" }, {});
      await expect(fixture.tool.execute("key-control", {}, undefined, undefined, {} as never)).rejects.toThrow(/keys.*control/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects locale files with more than the bounded number of flattened keys", async () => {
    const fixture = await createFixture();
    const oversized = Object.fromEntries(Array.from({ length: 50_001 }, (_, index) => [`key-${index}`, "value"]));
    await writeLocales(fixture.cwd, oversized, {});
    try {
      await expect(fixture.tool.execute("too-many-keys", {}, undefined, undefined, {} as never)).rejects.toThrow(/50,?000.*flattened keys/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("honors caller and plugin lifecycle cancellation", async () => {
    const callerFixture = await createFixture();
    await writeLocales(callerFixture.cwd, { greeting: "Hello" }, { greeting: "你好" });
    const controller = new AbortController();
    controller.abort(new Error("i18n caller cancelled"));
    try {
      await expect(callerFixture.tool.execute("caller", {}, controller.signal, undefined, {} as never)).rejects.toThrow("i18n caller cancelled");
    } finally {
      await callerFixture.context.fiber.dispose();
    }

    const lifecycleFixture = await createFixture();
    await writeLocales(lifecycleFixture.cwd, {}, {});
    await lifecycleFixture.context.fiber.dispose();
    await expect(lifecycleFixture.tool.execute("disposed", {}, undefined, undefined, {} as never)).rejects.toThrow("I18n pair plugin disposed");
    expect(lifecycleFixture.tools.snapshot().customTools).toEqual([]);
    await expect(lifecycleFixture.panels.snapshot()).resolves.toEqual([]);
  });

  test("publishes sanitized character- and UTF-8-bounded cancellation errors", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, {}, {});
    const controller = new AbortController();
    controller.abort(new Error(` unsafe\0\u202e${"界".repeat(3_000)}😀tail `));
    try {
      await expect(fixture.tool.execute("hostile-cancel", {}, controller.signal, undefined, {} as never)).rejects.toBeInstanceOf(Error);
      const [panel] = await fixture.panels.snapshot();
      const error = (panel?.data as { status?: { error?: unknown } } | undefined)?.status?.error;
      expect(typeof error).toBe("string");
      expect([...(error as string)]).toHaveLength(672);
      expect(Buffer.byteLength(error as string, "utf8")).toBeLessThanOrEqual(2_000);
      expect(error).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
      expect(error).toMatch(/^unsafe {2}/u);
      expect(error).not.toContain("tail");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("keeps tool and panel reports detached while bounding panel key inventories", async () => {
    const fixture = await createFixture();
    const base = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`base${String(index).padStart(3, "0")}`, "value"]));
    const target = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`target${String(index).padStart(3, "0")}`, "值"]));
    await writeLocales(fixture.cwd, base, target);
    try {
      const result = await fixture.tool.execute("bounded", {}, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ baseKeys: 120, targetKeys: 120 });
      expect((result.details as { missing: string[] }).missing).toHaveLength(120);
      (result.details as { missing: string[] }).missing[0] = "mutated-through-tool";

      const first = await fixture.panels.snapshot();
      expect(first).toMatchObject([
        {
          id: "i18n-pair-panel",
          data: {
            status: { state: "completed" },
            report: {
              base: "locales/en.json",
              target: "locales/zh-CN.json",
              baseKeys: 120,
              targetKeys: 120,
              missingTotal: 120,
              extraTotal: 120,
              truncated: true,
            },
            limits: { fileBytes: 4_194_304, depth: 128, keysPerFile: 50_000, flattenedKeyLength: 2_048, panelKeysPerSide: 100 },
          },
        },
      ]);
      const report = (first[0]?.data as { report: { missing: string[]; extra: string[] } }).report;
      expect(report.missing).toHaveLength(100);
      expect(report.extra).toHaveLength(100);
      expect(report.missing[0]).toBe("base000");
      report.missing[0] = "mutated-through-panel";

      const second = await fixture.panels.snapshot();
      expect((second[0]?.data as { report: { missing: string[] } }).report.missing[0]).toBe("base000");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("records bounded failure state without replacing the last successful report", async () => {
    const fixture = await createFixture();
    await writeLocales(fixture.cwd, { ready: "Ready" }, { ready: "就绪" });
    try {
      await fixture.tool.execute("success", {}, undefined, undefined, {} as never);
      await writeFile(join(fixture.cwd, "locales", "en.json"), "{", "utf8");
      await expect(fixture.tool.execute("failure", {}, undefined, undefined, {} as never)).rejects.toThrow(/invalid locale JSON/iu);

      const snapshot = await fixture.panels.snapshot();
      expect(snapshot).toMatchObject([
        {
          data: {
            status: { state: "failed" },
            report: { baseKeys: 1, targetKeys: 1, missing: [], extra: [] },
          },
        },
      ]);
      const status = (snapshot[0]?.data as { status: { error: string } }).status;
      expect(status.error).toMatch(/invalid locale JSON/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });
});
