import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import cleanerPlugin, { Config } from "../src/plugins/cleaner.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cleaner-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-cleaner-agent-"));
  temporaryDirectories.push(cwd, agentDir);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(cleanerPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "clean_harness_artifacts");
  if (tool === undefined) throw new Error("clean_harness_artifacts was not registered");
  return { context, cwd, agentDir, panels, tool, tools };
}

async function writeCapsules(agentDir: string, count: number): Promise<void> {
  const directory = join(agentDir, "capsules");
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, (_, index) => writeFile(join(directory, `${String(index).padStart(4, "0")}.patch`), `patch-${index}`, "utf8")),
  );
}

describe("cleaner production boundaries", () => {
  test("exports a strict empty config and a sequential strict-schema tool", async () => {
    expect(Config).toBeDefined();
    const fixture = await createFixture();
    try {
      expect(fixture.tool).toMatchObject({
        name: "clean_harness_artifacts",
        executionMode: "sequential",
        parameters: {
          additionalProperties: false,
          required: ["confirm"],
          properties: {
            confirm: { type: "boolean" },
            keep: { type: "integer", minimum: 0, maximum: 256 },
          },
        },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects unknown and hostile configuration before registering surfaces", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cleaner-config-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-cleaner-agent-"));
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
        await context.plugin(cleanerPlugin, { unexpected: true });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/unknown.*unexpected/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);

      let getterCalls = 0;
      const accessor = Object.defineProperty({}, "unexpected", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return true;
        },
      });
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      for (const config of ["invalid", accessor, { [Symbol("unexpected")]: true }, revocable.proxy]) {
        expect(() => cleanerPlugin.apply(context, config as never)).toThrow(
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
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cleaner-conflict-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-cleaner-agent-"));
    temporaryDirectories.push(cwd, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    panels.register({ id: "cleaner-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
    try {
      await expect(context.plugin(cleanerPlugin)).rejects.toThrow(/already registered.*cleaner-panel/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "cleaner-panel", pluginId: "fixture" }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("strictly validates raw parameters without invoking accessors", async () => {
    const fixture = await createFixture();
    let accessed = false;
    const accessor = { confirm: true } as { confirm: boolean; keep?: number };
    Object.defineProperty(accessor, "keep", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("cleaner accessor executed");
      },
    });
    try {
      await expect(fixture.tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(fixture.tool.execute("unknown", { confirm: true, unexpected: 1 }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(fixture.tool.execute("null", { confirm: true, keep: null }, undefined, undefined, {} as never)).rejects.toThrow(/keep.*integer/iu);
      await expect(fixture.tool.execute("nan", { confirm: true, keep: Number.NaN }, undefined, undefined, {} as never)).rejects.toThrow(/keep.*integer/iu);
      const inherited = Object.create({ confirm: true }) as Record<string, unknown>;
      await expect(fixture.tool.execute("inherited", inherited, undefined, undefined, {} as never)).rejects.toThrow(/plain object/iu);
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      await expect(fixture.tool.execute("revoked", revocable.proxy, undefined, undefined, {} as never)).rejects.toThrow(/accessible plain object/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("honors caller and plugin lifecycle cancellation before touching artifacts", async () => {
    const callerFixture = await createFixture();
    await writeCapsules(callerFixture.agentDir, 1);
    const controller = new AbortController();
    controller.abort(new Error("cleaner caller cancelled"));
    try {
      await expect(callerFixture.tool.execute("caller", { confirm: true, keep: 0 }, controller.signal, undefined, {} as never)).rejects.toThrow(
        "cleaner caller cancelled",
      );
      await expect(callerFixture.panels.snapshot()).resolves.toMatchObject([{ data: { inventory: { total: 1 } } }]);
    } finally {
      await callerFixture.context.fiber.dispose();
    }

    const lifecycleFixture = await createFixture();
    await writeCapsules(lifecycleFixture.agentDir, 1);
    await lifecycleFixture.context.fiber.dispose();
    await expect(lifecycleFixture.tool.execute("disposed", { confirm: true, keep: 0 }, undefined, undefined, {} as never)).rejects.toThrow(
      "Cleaner plugin disposed",
    );
    expect(lifecycleFixture.tools.snapshot().customTools).toEqual([]);
    await expect(lifecycleFixture.panels.snapshot()).resolves.toEqual([]);
  });

  test("ignores unsafe patch names instead of displaying or deleting them", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.agentDir, "capsules");
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "safe.patch"), "safe", "utf8"),
      writeFile(join(directory, "unsafe\n.patch"), "unsafe", "utf8"),
      writeFile(join(directory, "unsafe\u202e.patch"), "unsafe", "utf8"),
      writeFile(join(directory, "unsafe\\.patch"), "unsafe", "utf8"),
      writeFile(join(directory, "unsafe\u2028.patch"), "unsafe", "utf8"),
    ]);
    try {
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { capsules: [{ name: "safe.patch" }], inventory: { total: 1 } } }]);
      await expect(fixture.tool.execute("clean", { confirm: true, keep: 0 }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { removed: 1, kept: 0 },
      });
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { capsules: [], inventory: { total: 0 } } }]);
      await expect(readFile(join(directory, "unsafe\n.patch"), "utf8")).resolves.toBe("unsafe");
      await expect(readFile(join(directory, "unsafe\u202e.patch"), "utf8")).resolves.toBe("unsafe");
      await expect(readFile(join(directory, "unsafe\\.patch"), "utf8")).resolves.toBe("unsafe");
      await expect(readFile(join(directory, "unsafe\u2028.patch"), "utf8")).resolves.toBe("unsafe");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("publishes a bounded detached capsule inventory and explicit limits", async () => {
    const fixture = await createFixture();
    await writeCapsules(fixture.agentDir, 30);
    try {
      const first = await fixture.panels.snapshot();
      expect(first).toMatchObject([
        {
          id: "cleaner-panel",
          data: {
            inventory: { total: 30, shown: 20, truncated: true, displayLimit: 20 },
            lastCleanup: null,
            limits: { capsules: 256, directoryEntries: 4_096 },
          },
        },
      ]);
      const firstData = first[0]?.data as { capsules: Array<{ name: string; bytes: number }> };
      expect(firstData.capsules).toHaveLength(20);
      expect(firstData.capsules[0]).toEqual({ name: "0029.patch", bytes: 8 });
      firstData.capsules[0]!.name = "mutated.patch";

      const second = await fixture.panels.snapshot();
      expect((second[0]?.data as { capsules: Array<{ name: string }> }).capsules[0]?.name).toBe("0029.patch");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("reports completed cleanup activity with the final inventory count", async () => {
    const fixture = await createFixture();
    await writeCapsules(fixture.agentDir, 5);
    try {
      await expect(fixture.tool.execute("clean", { confirm: true, keep: 2 }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { removed: 3, kept: 2 },
      });
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        {
          data: {
            capsules: [{ name: "0004.patch" }, { name: "0003.patch" }],
            inventory: { total: 2, shown: 2, truncated: false },
            lastCleanup: { status: "completed", requestedKeep: 2, removed: 3, kept: 2 },
          },
        },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects an aborted queued cleanup before the active inventory scan completes", async () => {
    const fixture = await createFixture();
    await writeCapsules(fixture.agentDir, 30);
    const first = fixture.tool.execute("active", { confirm: true, keep: 30 }, undefined, undefined, {} as never);
    const controller = new AbortController();
    const second = fixture.tool.execute("queued", { confirm: true, keep: 0 }, controller.signal, undefined, {} as never);
    controller.abort(new Error("queued cleaner cancelled"));
    try {
      const firstOutcome = first.then(() => "active completed");
      const secondOutcome = second.then(
        () => "queued completed",
        (error: unknown) => (error instanceof Error ? error.message : "queued rejected"),
      );
      await expect(Promise.race([firstOutcome, secondOutcome])).resolves.toBe("queued cleaner cancelled");
      await expect(first).resolves.toMatchObject({ details: { removed: 0, kept: 30 } });
      await expect(second).rejects.toThrow("queued cleaner cancelled");
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { inventory: { total: 30 } } }]);
    } finally {
      await Promise.all([first.catch(() => undefined), second.catch(() => undefined)]);
      await fixture.context.fiber.dispose();
    }
  });

  test("publishes sanitized character- and UTF-8-bounded queued cancellation errors", async () => {
    const fixture = await createFixture();
    await writeCapsules(fixture.agentDir, 30);
    const active = fixture.tool.execute("active", { confirm: true, keep: 30 }, undefined, undefined, {} as never);
    const controller = new AbortController();
    const queued = fixture.tool.execute("queued", { confirm: true, keep: 0 }, controller.signal, undefined, {} as never);
    controller.abort(new Error(` unsafe\0\u202e${"界".repeat(3_000)}😀tail `));
    try {
      await Promise.all([active, queued.catch(() => undefined)]);
      const [panel] = await fixture.panels.snapshot();
      const activity = (panel?.data as { lastCleanup?: { status?: unknown; error?: unknown } } | undefined)?.lastCleanup;
      expect(activity?.status).toBe("cancelled");
      expect(typeof activity?.error).toBe("string");
      expect([...(activity?.error as string)]).toHaveLength(672);
      expect(Buffer.byteLength(activity?.error as string, "utf8")).toBeLessThanOrEqual(2_000);
      expect(activity?.error).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
      expect(activity?.error).toMatch(/^unsafe {2}/u);
    } finally {
      await Promise.all([active.catch(() => undefined), queued.catch(() => undefined)]);
      await fixture.context.fiber.dispose();
    }
  });

  test("retains bounded failure activity after the capsule directory is repaired", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "pi-harness-cleaner-outside-"));
    temporaryDirectories.push(outside);
    const directory = join(fixture.agentDir, "capsules");
    await symlink(outside, directory);
    try {
      await expect(fixture.tool.execute("failure", { confirm: true, keep: 0 }, undefined, undefined, {} as never)).rejects.toThrow(/symbolic link/iu);
      await rm(directory);
      await mkdir(directory);
      const snapshot = await fixture.panels.snapshot();
      expect(snapshot).toMatchObject([{ data: { lastCleanup: { status: "failed", requestedKeep: 0, removed: 0 } } }]);
      const activity = (snapshot[0]?.data as { lastCleanup: { error: string } }).lastCleanup;
      expect(activity.error).toMatch(/symbolic link/iu);
      expect(activity.error.length).toBeLessThanOrEqual(2_000);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });
});
