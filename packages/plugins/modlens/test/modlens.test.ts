import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import modlensPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-modlens-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-modlens-agent-"));
  temporaryDirectories.push(cwd, agentDir);
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  return { context, cwd, tools, panels };
}

async function modlensPanelData(panels: PiPluginUiRegistry): Promise<Record<string, unknown>> {
  const data = (await panels.snapshot()).find((panel) => panel.id === "modlens-panel")?.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("modlens panel data was not an object");
  return data as Record<string, unknown>;
}

function modlensPanelStatus(data: Record<string, unknown>): Record<string, unknown> {
  const status = data.status;
  if (status === null || typeof status !== "object" || Array.isArray(status)) throw new Error("modlens panel status was not an object");
  return status as Record<string, unknown>;
}

function completeVisionEvidence(summary: string) {
  return {
    summary,
    ocr: { full_text: "", lines: [] },
    layout: { regions: [] },
    semantics: { scene: "", entities: [] },
    visual: {},
    uncertainty: [],
  };
}

describe("modlens plugin", () => {
  test("rejects an explicitly blank CLI path before registering surfaces", async () => {
    const { context, tools, panels } = await fixture();
    let failure: unknown;

    try {
      await context.plugin(modlensPlugin, { cliPath: "   " });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/cliPath.*non-empty/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("rejects unknown configuration before registering surfaces", async () => {
    const { context, tools, panels } = await fixture();
    let failure: unknown;

    try {
      await context.plugin(modlensPlugin, { unexpected: true } as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/unknown.*unexpected/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test.each([
    [{ timeoutMs: 999 }, /timeoutMs/iu],
    [{ timeoutMs: 300_001 }, /timeoutMs/iu],
    [{ timeoutMs: Number.NaN }, /timeoutMs/iu],
    [{ cliPath: "relative/modlens.mjs" }, /cliPath.*absolute/iu],
  ] as const)("rejects invalid configuration %# before registering surfaces", async (config, message) => {
    const { context, tools, panels } = await fixture();
    let failure: unknown;

    try {
      await context.plugin(modlensPlugin, config);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(message);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("rolls back its tool registration when panel registration fails", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "activation-rollback-engine.mjs");
    await writeFile(cliPath, "", "utf8");
    panels.register({
      id: "modlens-panel",
      pluginId: "fixture",
      title: "Fixture",
      read: () => ({}),
    });

    await expect(context.plugin(modlensPlugin, { cliPath })).rejects.toThrow(/panel is already registered: modlens-panel/iu);

    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "modlens-panel", pluginId: "fixture" }]);
  });

  test("returns structured visual evidence to a text-only model", async () => {
    const { context, cwd, tools } = await fixture();
    const imagePath = join(cwd, "diagram.png");
    const cliPath = join(cwd, "modlens-fixture.mjs");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    const evidence = { ...completeVisionEvidence("A one-pixel diagram"), ocr: { full_text: "OK", lines: [] } };
    await writeFile(cliPath, `process.stdout.write(${JSON.stringify(JSON.stringify({ result: evidence }))});\n`, "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    const result = await tool.execute("inspect", { path: "diagram.png" }, undefined, undefined, { model: { input: ["text"] } } as never);

    const content = result.content[0];
    if (content?.type !== "text") throw new Error("expected text evidence");
    expect(content.text).toContain("A one-pixel diagram");
    expect(result.details).toMatchObject({
      mode: "evidence",
      path: "diagram.png",
      mimeType: "image/png",
      evidence: { summary: "A one-pixel diagram", ocr: { full_text: "OK" }, uncertainty: [] },
    });
  });

  test("rejects evidence that does not match the bundled ModLens vision schema", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "incomplete-engine.mjs");
    await writeFile(join(cwd, "incomplete.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(cliPath, 'process.stdout.write(JSON.stringify({ result: { summary: "incomplete" } }));\n', "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    await expect(tool.execute("inspect", { path: "incomplete.png" }, undefined, undefined, { model: { input: ["text"] } } as never)).rejects.toThrow(
      /vision schema.*ocr/iu,
    );
    const data = await modlensPanelData(panels);
    const status = modlensPanelStatus(data);
    expect(data.attached).toBe(false);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/vision schema.*ocr/iu);
  });

  test("rejects a non-string semantic intent from the bundled ModLens vision schema", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "invalid-intent-engine.mjs");
    const evidence = { ...completeVisionEvidence("invalid intent"), semantics: { scene: "", entities: [], intent: 123 } };
    await writeFile(join(cwd, "invalid-intent.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(cliPath, `process.stdout.write(${JSON.stringify(JSON.stringify({ result: evidence }))});\n`, "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    await expect(tool.execute("inspect", { path: "invalid-intent.png" }, undefined, undefined, { model: { input: ["text"] } } as never)).rejects.toThrow(
      /vision schema.*result\.semantics\.intent/iu,
    );
  });

  test("truncates large Agent evidence on a valid UTF-8 boundary", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "large-unicode-engine.mjs");
    const evidence = completeVisionEvidence("😀".repeat(40_000));
    await writeFile(join(cwd, "unicode.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(cliPath, `process.stdout.write(${JSON.stringify(JSON.stringify({ result: evidence }))});\n`, "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    const result = await tool.execute("inspect", { path: "unicode.png" }, undefined, undefined, { model: { input: ["text"] } } as never);
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("expected text evidence");
    expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(128 * 1_024);
    expect(content.text).toContain("evidence truncated");
    expect(content.text).not.toContain("�");
  });

  test("rejects a supported extension when the bytes are not that image format", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "modlens-fixture.mjs");
    await writeFile(join(cwd, "fake.png"), "not an image", "utf8");
    await writeFile(cliPath, 'process.stdout.write(JSON.stringify({ result: { summary: "must not run" } }));\n', "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    await expect(tool.execute("inspect", { path: "fake.png" }, undefined, undefined, { model: { input: ["image"] } } as never)).rejects.toThrow(
      /image bytes.*png/iu,
    );
    const data = await modlensPanelData(panels);
    const status = modlensPanelStatus(data);
    expect(data.attached).toBe(false);
    expect(status).toMatchObject({ state: "failed", path: "fake.png" });
    expect(status.error).toMatch(/image bytes.*png/iu);
  });

  test("rejects hostile parameters without invoking getters or the engine", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "parameter-engine.mjs");
    const invokedPath = join(cwd, "engine-invoked.txt");
    await writeFile(join(cwd, "valid.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(cliPath, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(invokedPath)}, "yes");\n`, "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");
    let getterCalls = 0;
    const getter = Object.defineProperty({}, "path", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "valid.png";
      },
    });
    const inherited = Object.create({ path: "valid.png" }) as Record<string, unknown>;
    const cases: unknown[] = [
      null,
      [],
      getter,
      inherited,
      { path: "valid.png", unknown: true },
      { path: `valid.png${"x".repeat(4_096)}` },
      { path: "valid.png", prompt: "x".repeat(4_001) },
      { path: "valid\0.png" },
    ];

    for (const [index, params] of cases.entries()) {
      await expect(tool.execute(`invalid-${index}`, params, undefined, undefined, { model: { input: ["text"] } } as never)).rejects.toThrow();
    }
    expect(getterCalls).toBe(0);
    expect(existsSync(invokedPath)).toBe(false);
    expect(tool.parameters).toMatchObject({ additionalProperties: false, properties: { path: { maxLength: 4_096 }, prompt: { maxLength: 4_000 } } });
    expect(tool.executionMode).toBe("sequential");
    const data = await modlensPanelData(panels);
    const status = modlensPanelStatus(data);
    expect(data.attached).toBe(false);
    expect(status).toMatchObject({ state: "failed", path: "invalid tool input" });
    expect(status.error).toMatch(/path/iu);
  });

  test("rejects an image larger than the fixed 10 MiB boundary before invoking the engine", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "size-engine.mjs");
    const invokedPath = join(cwd, "size-engine-invoked.txt");
    const image = Buffer.alloc(10 * 1_024 * 1_024 + 1);
    Buffer.from("iVBORw0KGgo=", "base64").copy(image);
    await writeFile(join(cwd, "oversized.png"), image);
    await writeFile(cliPath, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(invokedPath)}, "yes");\n`, "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    await expect(tool.execute("inspect", { path: "oversized.png" }, undefined, undefined, { model: { input: ["text"] } } as never)).rejects.toThrow(
      /10485760-byte limit/iu,
    );
    expect(existsSync(invokedPath)).toBe(false);
  });

  test("runs the evidence engine against an immutable snapshot of the validated image bytes", async () => {
    const { context, cwd, tools } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "pi-harness-modlens-outside-"));
    temporaryDirectories.push(outside);
    const imagePath = join(cwd, "race.png");
    const secretPath = join(outside, "secret.png");
    const cliPath = join(cwd, "snapshot-engine.mjs");
    const startedPath = join(cwd, "snapshot-started.txt");
    const releasePath = join(cwd, "snapshot-release.txt");
    const invokedImagePath = join(cwd, "snapshot-image-path.txt");
    const engineCwdPath = join(cwd, "snapshot-engine-cwd.txt");
    const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64");
    const secret = Buffer.from("outside secret that was never validated", "utf8");
    await writeFile(imagePath, original);
    await writeFile(secretPath, secret);
    await writeFile(
      cliPath,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs"; const imagePath = process.argv[process.argv.indexOf("-i") + 1]; writeFileSync(${JSON.stringify(invokedImagePath)}, imagePath); writeFileSync(${JSON.stringify(engineCwdPath)}, process.cwd()); writeFileSync(${JSON.stringify(startedPath)}, "started"); const timer = setInterval(() => { if (!existsSync(${JSON.stringify(releasePath)})) return; clearInterval(timer); const summary = readFileSync(imagePath).toString("base64"); process.stdout.write(JSON.stringify({ result: { summary, ocr: { full_text: "", lines: [] }, layout: { regions: [] }, semantics: { scene: "", entities: [] }, visual: {}, uncertainty: [] } })); }, 10);\n`,
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    const execution = tool.execute("inspect", { path: "race.png" }, undefined, undefined, { model: { input: ["text"] } } as never);
    await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 5_000, interval: 10 });
    await unlink(imagePath);
    await symlink(secretPath, imagePath);
    await writeFile(releasePath, "release", "utf8");
    const result = await execution;
    const engineImagePath = await readFile(invokedImagePath, "utf8");

    expect(result.details).toMatchObject({ evidence: { summary: original.toString("base64") } });
    expect(engineImagePath).not.toBe(imagePath);
    expect(existsSync(engineImagePath)).toBe(false);
    await expect(readFile(engineCwdPath, "utf8")).resolves.toBe(await realpath(cwd));
  });

  test("passes an untrusted focus as one argv value without shell interpretation", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "argv-engine.mjs");
    const injectedPath = join(cwd, "must-not-exist.txt");
    const prompt = `labels; touch ${injectedPath}`;
    await writeFile(join(cwd, "argv.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(
      cliPath,
      'const index = process.argv.indexOf("--prompt"); const summary = process.argv[index + 1]; process.stdout.write(JSON.stringify({ result: { summary, ocr: { full_text: "", lines: [] }, layout: { regions: [] }, semantics: { scene: "", entities: [] }, visual: {}, uncertainty: [] } }));\n',
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    const result = await tool.execute("inspect", { path: "argv.png", prompt }, undefined, undefined, { model: { input: ["text"] } } as never);
    expect(result.details).toMatchObject({ evidence: { summary: prompt } });
    expect(existsSync(injectedPath)).toBe(false);
  });

  test("rejects invalid, oversized, and schema-oversized engine output", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "bad-output-engine.mjs");
    await writeFile(join(cwd, "output.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(cliPath, 'process.stdout.write("not-json");\n', "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");
    const executionContext = { model: { input: ["text"] } } as never;

    await expect(tool.execute("invalid-json", { path: "output.png" }, undefined, undefined, executionContext)).rejects.toThrow(/valid JSON/iu);
    await writeFile(cliPath, 'process.stdout.write("x".repeat(1_048_577));\n', "utf8");
    await expect(tool.execute("large-stdout", { path: "output.png" }, undefined, undefined, executionContext)).rejects.toThrow(/1048576-byte limit/iu);
    const oversizedEvidence = completeVisionEvidence("x".repeat(525_000));
    await writeFile(cliPath, `process.stdout.write(${JSON.stringify(JSON.stringify({ result: oversizedEvidence }))});\n`, "utf8");
    await expect(tool.execute("large-evidence", { path: "output.png" }, undefined, undefined, executionContext)).rejects.toThrow(/524288-byte limit/iu);
  });

  test("bounds and sanitizes a failed engine diagnostic for the caller and panel status", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "failure-engine.mjs");
    await writeFile(join(cwd, "failure.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(cliPath, 'process.stderr.write("provider\\n\\u001b[31m\\u202e" + "x".repeat(3_000)); process.exit(7);\n', "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    let failure: unknown;
    try {
      await tool.execute("inspect", { path: "failure.png" }, undefined, undefined, { model: { input: ["text"] } } as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("exit 7");
    expect((failure as Error).message.length).toBeLessThanOrEqual(2_000);
    expect((failure as Error).message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    const panel = (await panels.snapshot())[0]?.data as { status?: { error?: unknown } };
    const error = panel.status?.error;
    expect(typeof error).toBe("string");
    expect((error as string).length).toBeLessThanOrEqual(2_000);
    expect(error).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  test("times out the engine and terminates it at the configured production floor", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "timeout-engine.mjs");
    const startedPath = join(cwd, "timeout-started.txt");
    const stoppedPath = join(cwd, "timeout-stopped.txt");
    await writeFile(join(cwd, "timeout.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(
      cliPath,
      `import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(stoppedPath)}, "stopped"); process.exit(0); }); writeFileSync(${JSON.stringify(startedPath)}, "started"); setInterval(() => {}, 1_000);\n`,
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath, timeoutMs: 1_000 });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    const execution = tool.execute("inspect", { path: "timeout.png" }, undefined, undefined, { model: { input: ["text"] } } as never);
    await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 5_000, interval: 10 });
    await expect(execution).rejects.toThrow(/timed out after 1000 ms/iu);
    await vi.waitFor(() => expect(existsSync(stoppedPath)).toBe(true), { timeout: 5_000, interval: 10 });
    const status = modlensPanelStatus(await modlensPanelData(panels));
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/timed out/iu);
  });

  test("sends a bounded image directly to a native vision model without invoking the bridge", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "must-not-run.mjs");
    await writeFile(join(cwd, "native.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(cliPath, 'throw new Error("bridge must not run");\n', "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    const result = await tool.execute("inspect", { path: "native.png" }, undefined, undefined, { model: { input: ["text", "image"] } } as never);
    expect(result.content).toEqual([{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" }]);
    expect(result.details).toMatchObject({ mode: "native", path: "native.png", mimeType: "image/png", bytes: 24, cached: false });
    (result.details as { path: string }).path = "mutated.png";
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { attached: true, image: { mode: "native", path: "native.png" } } }]);
  });

  test("recognizes every documented local image format by extension and magic bytes", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "format-must-not-run.mjs");
    const images = [
      { path: "image.png", bytes: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png" },
      { path: "image.jpg", bytes: Buffer.from("ffd8ff", "hex"), mimeType: "image/jpeg" },
      { path: "image.gif", bytes: Buffer.from("GIF89a", "ascii"), mimeType: "image/gif" },
      { path: "image.webp", bytes: Buffer.from("524946460000000057454250", "hex"), mimeType: "image/webp" },
    ] as const;
    await Promise.all(images.map(async (image) => writeFile(join(cwd, image.path), image.bytes)));
    await writeFile(cliPath, 'throw new Error("bridge must not run");\n', "utf8");
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    for (const image of images) {
      const result = await tool.execute(`inspect-${image.path}`, { path: image.path }, undefined, undefined, { model: { input: ["image"] } } as never);
      expect(result.content).toEqual([{ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType }]);
    }
  });

  test("caches successful text-model evidence by image content and focus", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "cached-engine.mjs");
    const countPath = join(cwd, "calls.txt");
    await writeFile(join(cwd, "cached.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(
      cliPath,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs"; const file = ${JSON.stringify(countPath)}; const count = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0; writeFileSync(file, String(count + 1)); process.stdout.write(${JSON.stringify(JSON.stringify({ result: completeVisionEvidence("cached evidence") }))});\n`,
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");
    const executionContext = { model: { input: ["text"] } } as never;

    const first = await tool.execute("first", { path: "cached.png", prompt: "labels" }, undefined, undefined, executionContext);
    (first.details as { evidence: { summary: string } }).evidence.summary = "mutated by caller";
    const second = await tool.execute("second", { path: "cached.png", prompt: "labels" }, undefined, undefined, executionContext);

    expect(first.details).toMatchObject({ mode: "evidence", cached: false });
    expect(second.details).toMatchObject({ mode: "evidence", cached: true, evidence: { summary: "cached evidence" } });
    const secondContent = second.content[0];
    if (secondContent?.type !== "text") throw new Error("expected cached text evidence");
    expect(secondContent.text).toContain("cached evidence");
    await expect(readFile(countPath, "utf8")).resolves.toBe("1");
    const panel = (await panels.snapshot())[0]?.data;
    expect(JSON.stringify(panel)).not.toContain("cached evidence");
    expect(panel).toMatchObject({ image: { mode: "evidence", cached: true }, status: { state: "completed", mode: "evidence", cached: true } });
  });

  test("does not cache failed engine output", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "failed-cache-engine.mjs");
    const countPath = join(cwd, "failed-cache-calls.txt");
    await writeFile(join(cwd, "failed-cache.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(
      cliPath,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs"; const file = ${JSON.stringify(countPath)}; const count = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0; writeFileSync(file, String(count + 1)); process.stdout.write("not-json");\n`,
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");
    const executionContext = { model: { input: ["text"] } } as never;

    await expect(tool.execute("first", { path: "failed-cache.png" }, undefined, undefined, executionContext)).rejects.toThrow(/valid JSON/iu);
    await expect(tool.execute("second", { path: "failed-cache.png" }, undefined, undefined, executionContext)).rejects.toThrow(/valid JSON/iu);
    await expect(readFile(countPath, "utf8")).resolves.toBe("2");
  });

  test("keeps recently reused evidence when the bounded LRU cache evicts an entry", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "lru-engine.mjs");
    const countPath = join(cwd, "lru-calls.txt");
    await writeFile(join(cwd, "lru.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(
      cliPath,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs"; const file = ${JSON.stringify(countPath)}; const count = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0; writeFileSync(file, String(count + 1)); process.stdout.write(${JSON.stringify(JSON.stringify({ result: completeVisionEvidence("LRU evidence") }))});\n`,
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");
    const executionContext = { model: { input: ["text"] } } as never;

    for (let index = 0; index < 64; index += 1) {
      await tool.execute(`seed-${index}`, { path: "lru.png", prompt: `focus-${index}` }, undefined, undefined, executionContext);
    }
    await tool.execute("reuse-first", { path: "lru.png", prompt: "focus-0" }, undefined, undefined, executionContext);
    await tool.execute("overflow", { path: "lru.png", prompt: "focus-64" }, undefined, undefined, executionContext);
    const reused = await tool.execute("reuse-first-again", { path: "lru.png", prompt: "focus-0" }, undefined, undefined, executionContext);

    expect(reused.details).toMatchObject({ cached: true });
    await expect(readFile(countPath, "utf8")).resolves.toBe("65");
  }, 15_000);

  test("cancels a running evidence engine when the caller aborts", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "blocking-engine.mjs");
    const startedPath = join(cwd, "started.txt");
    const stoppedPath = join(cwd, "stopped.txt");
    await writeFile(join(cwd, "blocking.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(
      cliPath,
      `import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(stoppedPath)}, "stopped"); process.exit(0); }); writeFileSync(${JSON.stringify(startedPath)}, "started"); setInterval(() => {}, 1_000);\n`,
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");
    const abort = new AbortController();

    const execution = tool.execute("inspect", { path: "blocking.png" }, abort.signal, undefined, { model: { input: ["text"] } } as never);
    await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 5_000, interval: 10 });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { status: { state: "running", mode: "evidence", path: "blocking.png" } } }]);
    abort.abort(new Error("caller stopped inspection"));

    await expect(execution).rejects.toThrow(/cancelled/iu);
    await vi.waitFor(() => expect(existsSync(stoppedPath)).toBe(true), { timeout: 5_000, interval: 10 });
    const data = await modlensPanelData(panels);
    const status = modlensPanelStatus(data);
    expect(data.attached).toBe(false);
    expect(status).toMatchObject({ state: "cancelled", mode: "evidence", path: "blocking.png" });
    expect(status.error).toMatch(/cancelled/iu);
  });

  test("terminates a running evidence engine and unregisters surfaces when disposed", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const cliPath = join(cwd, "dispose-engine.mjs");
    const startedPath = join(cwd, "dispose-started.txt");
    const stoppedPath = join(cwd, "dispose-stopped.txt");
    await writeFile(join(cwd, "dispose.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(
      cliPath,
      `import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(stoppedPath)}, "stopped"); process.exit(0); }); writeFileSync(${JSON.stringify(startedPath)}, "started"); setInterval(() => {}, 1_000);\n`,
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");

    const execution = tool.execute("inspect", { path: "dispose.png" }, undefined, undefined, { model: { input: ["text"] } } as never);
    await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 5_000, interval: 10 });
    await context.fiber.dispose();

    await expect(execution).rejects.toThrow(/cancelled/iu);
    await vi.waitFor(() => expect(existsSync(stoppedPath)).toBe(true), { timeout: 5_000, interval: 10 });
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("cancels the evidence engine process tree so provider children cannot outlive the call", async () => {
    const { context, cwd, tools } = await fixture();
    const cliPath = join(cwd, "tree-engine.mjs");
    const providerReadyPath = join(cwd, "provider-ready.txt");
    const providerStoppedPath = join(cwd, "provider-stopped.txt");
    const providerPidPath = join(cwd, "provider-pid.txt");
    const providerSource = `const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(providerStoppedPath)}, "stopped"); process.exit(0); }); writeFileSync(${JSON.stringify(providerReadyPath)}, "ready"); setInterval(() => {}, 1_000);`;
    await writeFile(join(cwd, "tree.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    await writeFile(
      cliPath,
      `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const provider = spawn(process.execPath, ["-e", ${JSON.stringify(providerSource)}], { stdio: "ignore" }); writeFileSync(${JSON.stringify(providerPidPath)}, String(provider.pid)); setInterval(() => {}, 1_000);\n`,
      "utf8",
    );
    await context.plugin(modlensPlugin, { cliPath });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_inspect");
    if (tool === undefined) throw new Error("vision_inspect was not registered");
    const abort = new AbortController();
    let providerPid: number | undefined;

    try {
      const execution = tool.execute("inspect", { path: "tree.png" }, abort.signal, undefined, { model: { input: ["text"] } } as never);
      await vi.waitFor(() => expect(existsSync(providerReadyPath)).toBe(true), { timeout: 5_000, interval: 10 });
      providerPid = Number(await readFile(providerPidPath, "utf8"));
      abort.abort(new Error("caller stopped inspection"));

      await expect(execution).rejects.toThrow(/cancelled/iu);
      await vi.waitFor(() => expect(existsSync(providerStoppedPath)).toBe(true), { timeout: 500, interval: 10 });
    } finally {
      if (providerPid !== undefined) {
        try {
          process.kill(providerPid, "SIGKILL");
        } catch {
          // The expected process-tree shutdown already removed it.
        }
      }
    }
  });
});
