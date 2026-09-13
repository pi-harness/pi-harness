import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import visionToolkitPlugin, { catalogImages, imageInfo } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const temporaryDirectories: string[] = [];
const contexts: Context[] = [];

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new Error("Expected an object in the Vision Toolkit test fixture");
  return value as Record<string, unknown>;
}

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpegWithLateDimensions(width: number, height: number): Buffer {
  const segments = Array.from({ length: 5 }, () => {
    const segment = Buffer.alloc(65_537);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    segment.writeUInt16BE(65_535, 2);
    return segment;
  });
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, sof]);
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-agent-"));
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

describe("vision toolkit", () => {
  test.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
    const { cwd } = await fixture();
    const fifo = join(cwd, "pipe.png");
    execFileSync("mkfifo", [fifo]);
    let writerNeeded = false;
    const rescue = setTimeout(() => {
      writerNeeded = true;
      const descriptor = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      closeSync(descriptor);
    }, 1_000);
    try {
      await expect(imageInfo(cwd, "pipe.png")).rejects.toThrow(/regular file/iu);
      expect(writerNeeded).toBe(false);
    } finally {
      clearTimeout(rescue);
    }
  });

  test("reads the native workspace and clears old results on in-place session changes", async () => {
    const { context, cwd, tools, panels } = await fixture();
    const active = join(cwd, "active");
    await mkdir(active);
    await writeFile(join(cwd, "launch.png"), png(10, 10));
    await writeFile(join(active, "current.png"), png(32, 18));
    const session = { sessionId: "first", sessionManager: { getCwd: () => active } };
    context.provide("piRuntime", { session } as never);
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((t) => t.name === "vision_catalog")!;
    const info = tools.snapshot().customTools.find((t) => t.name === "vision_image_info")!;
    const result = await catalog.execute("catalog", {}, undefined, undefined, {} as never);
    expect((result.details as { assets: { path: string }[] }).assets.map((asset) => asset.path)).toEqual(["current.png"]);
    await expect(info.execute("info", { path: "current.png" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { width: 32, height: 18 },
    });
    session.sessionId = "next";
    expect((await panels.snapshot())[0]?.data).toMatchObject({ status: { state: "idle" }, report: null });
  });

  test("rejects stale completion without publishing it in the replacement session", async () => {
    const { context, cwd, tools, panels } = await fixture();
    await writeFile(join(cwd, "image.png"), png(32, 18));
    const session = { sessionId: "first", sessionManager: { getCwd: () => cwd } };
    context.provide("piRuntime", { session } as never);
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((t) => t.name === "vision_catalog")!;
    const run = catalog.execute("catalog", {}, undefined, undefined, {} as never);
    const rejected = expect(run).rejects.toThrow(/workspace changed/iu);
    session.sessionId = "next";
    const during = (await panels.snapshot())[0]?.data;
    await rejected;
    expect(during).toMatchObject({ status: { state: "idle" }, report: null });
    expect((await panels.snapshot())[0]?.data).toMatchObject({ status: { state: "idle" }, report: null });
  });

  test("rejects overlapping tool requests without replacing the active operation status", async () => {
    const { context, cwd, tools, panels } = await fixture();
    await writeFile(join(cwd, "image.png"), png(32, 18));
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((t) => t.name === "vision_catalog")!;
    const info = tools.snapshot().customTools.find((t) => t.name === "vision_image_info")!;
    const run = catalog.execute("catalog", {}, undefined, undefined, {} as never);
    await expect(info.execute("overlap", { path: "image.png" }, undefined, undefined, {} as never)).rejects.toThrow(/already running/iu);
    await run;
    expect((await panels.snapshot())[0]?.data).toMatchObject({ status: { state: "completed", operation: "catalog" } });
    await expect(info.execute("after", { path: "image.png" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { width: 32 } });
  });

  test("catalogs supported workspace images with dimensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "designs"));
    await writeFile(join(root, "designs", "hero.png"), png(320, 180));
    await writeFile(join(root, "notes.txt"), "not an image");

    await expect(catalogImages(root)).resolves.toEqual([
      { path: "designs/hero.png", mimeType: "image/png", bytes: 24, width: 320, height: 180, headerTruncated: false },
    ]);
  });

  test("rejects image paths outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-outside-"));
    temporaryDirectories.push(root);
    temporaryDirectories.push(outside);
    await expect(imageInfo(root, "../outside.png")).rejects.toThrow(/inside the workspace/);
    await writeFile(join(outside, "outside.png"), Buffer.alloc(24));
    await symlink(outside, join(root, "linked"));
    await expect(imageInfo(root, "linked/outside.png")).rejects.toThrow(/inside the workspace/);
  });

  test("rejects image extensions whose bytes are not the claimed format", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "fake.png"), "not a PNG", "utf8");

    await expect(imageInfo(root, "fake.png")).rejects.toThrow(/bytes do not match.*png/iu);
  });

  test("reads dimensions from PNG, GIF, JPEG, and every WebP bitstream form", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(321, 6);
    gif.writeUInt16LE(181, 8);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xb6, 0x01, 0x42, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
    const vp8x = Buffer.alloc(30);
    vp8x.write("RIFF", 0, "ascii");
    vp8x.writeUInt32LE(22, 4);
    vp8x.write("WEBPVP8X", 8, "ascii");
    vp8x.writeUInt32LE(10, 16);
    vp8x.writeUIntLE(322 - 1, 24, 3);
    vp8x.writeUIntLE(182 - 1, 27, 3);
    const vp8l = Buffer.alloc(25);
    vp8l.write("RIFF", 0, "ascii");
    vp8l.writeUInt32LE(17, 4);
    vp8l.write("WEBPVP8L", 8, "ascii");
    vp8l.writeUInt32LE(5, 16);
    vp8l[20] = 0x2f;
    const losslessWidth = 323 - 1;
    const losslessHeight = 183 - 1;
    vp8l[21] = losslessWidth & 0xff;
    vp8l[22] = ((losslessWidth >> 8) & 0x3f) | ((losslessHeight & 0x03) << 6);
    vp8l[23] = (losslessHeight >> 2) & 0xff;
    vp8l[24] = (losslessHeight >> 10) & 0x0f;
    const vp8 = Buffer.alloc(30);
    vp8.write("RIFF", 0, "ascii");
    vp8.writeUInt32LE(22, 4);
    vp8.write("WEBPVP8 ", 8, "ascii");
    vp8.writeUInt32LE(10, 16);
    Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a]).copy(vp8, 20);
    vp8.writeUInt16LE(324, 26);
    vp8.writeUInt16LE(184, 28);
    const fixtures = [
      ["image.png", png(320, 180), 320, 180],
      ["image.gif", gif, 321, 181],
      ["image.jpg", jpeg, 322, 182],
      ["extended.webp", vp8x, 322, 182],
      ["lossless.webp", vp8l, 323, 183],
      ["lossy.webp", vp8, 324, 184],
    ] as const;
    await Promise.all(fixtures.map(async ([name, data]) => writeFile(join(root, name), data)));

    await expect(Promise.all(fixtures.map(async ([name]) => imageInfo(root, name)))).resolves.toMatchObject(
      fixtures.map(([path, , width, height]) => ({ path, width, height })),
    );
  });

  test("rejects a recognized image signature with a malformed or zero-sized header", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "zero.png"), png(0, 180));
    await writeFile(join(root, "truncated.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

    await expect(imageInfo(root, "zero.png")).rejects.toThrow(/malformed.*dimensions/iu);
    await expect(imageInfo(root, "truncated.jpg")).rejects.toThrow(/malformed.*dimensions/iu);
  });

  test("bounds header reads and reports when late JPEG dimensions were not reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    const jpeg = jpegWithLateDimensions(640, 360);
    await writeFile(join(root, "late.jpg"), jpeg);

    await expect(imageInfo(root, "late.jpg")).resolves.toEqual({
      path: "late.jpg",
      mimeType: "image/jpeg",
      bytes: jpeg.length,
      width: null,
      height: null,
      headerTruncated: true,
    });
  });

  test("accepts JPEG fill bytes and standalone markers before the dimensions segment", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xb4, 0x01, 0x40, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xe0, 0x00, 0x02, 0xff, 0x01]), sof]);
    await writeFile(join(root, "markers.jpg"), jpeg);

    await expect(imageInfo(root, "markers.jpg")).resolves.toMatchObject({ width: 320, height: 180, headerTruncated: false });
  });

  test("continues cataloging valid assets when another image is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "bad.png"), "not a PNG", "utf8");
    await writeFile(join(root, "good.png"), png(640, 360));

    await expect(catalogImages(root)).resolves.toEqual([
      { path: "good.png", mimeType: "image/png", bytes: 24, width: 640, height: 360, headerTruncated: false },
    ]);
  });

  test("bounds catalog traversal and reports when directory discovery is truncated", async () => {
    const { context, cwd, tools, panels } = await fixture();
    for (let index = 0; index < 513; index += 1) await mkdir(join(cwd, `directory-${String(index).padStart(3, "0")}`));
    await context.plugin(visionToolkitPlugin, {});
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    if (tool === undefined) throw new Error("vision_catalog was not registered");

    const result = await tool.execute("catalog", {}, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ assets: [], scannedDirectories: 512, truncated: true });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { report: { scannedDirectories: 512, truncated: true } } }]);
  });

  test("rejects hostile image-info parameters without invoking accessors", async () => {
    const { context, cwd, tools } = await fixture();
    await writeFile(join(cwd, "valid.png"), png(32, 18));
    await context.plugin(visionToolkitPlugin, {});
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_image_info");
    if (tool === undefined) throw new Error("vision_image_info was not registered");
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
      { path: " " },
      { path: "valid\0.png" },
      { path: "x".repeat(4_097) },
    ];

    for (const [index, params] of cases.entries()) await expect(tool.execute(`invalid-${index}`, params, undefined, undefined, {} as never)).rejects.toThrow();

    expect(getterCalls).toBe(0);
    expect(tool.parameters).toMatchObject({ additionalProperties: false, properties: { path: { minLength: 1, maxLength: 4_096 } } });
  });

  test("rolls back both tools when panel registration fails", async () => {
    const { context, tools, panels } = await fixture();
    panels.register({ id: "vision-toolkit-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });

    await expect(context.plugin(visionToolkitPlugin, {})).rejects.toThrow(/panel is already registered: vision-toolkit-panel/iu);

    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "vision-toolkit-panel", pluginId: "fixture" }]);
  });

  test("rejects unknown configuration before registering surfaces", async () => {
    const { context, tools, panels } = await fixture();
    let failure: unknown;

    try {
      await context.plugin(visionToolkitPlugin, { unexpected: true });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/unknown.*unexpected/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("honors caller cancellation for both tools and exposes cancelled status", async () => {
    const { context, cwd, tools, panels } = await fixture();
    await writeFile(join(cwd, "valid.png"), png(32, 18));
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    const info = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_image_info");
    if (catalog === undefined || info === undefined) throw new Error("vision toolkit tools were not registered");
    const abort = new AbortController();
    abort.abort(new Error("caller stopped vision inspection"));

    await expect(catalog.execute("catalog", {}, abort.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    await expect(info.execute("info", { path: "valid.png" }, abort.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);

    const status = asRecord(asRecord((await panels.snapshot())[0]?.data).status);
    expect(status).toMatchObject({ state: "cancelled", operation: "info", path: "valid.png" });
    expect(typeof status.error).toBe("string");
    if (typeof status.error !== "string") throw new Error("Expected a cancellation error in the panel status");
    expect(status.error).toMatch(/cancelled/iu);
  });

  test("rejects hostile catalog parameters without invoking accessors", async () => {
    const { context, tools } = await fixture();
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    if (catalog === undefined) throw new Error("vision_catalog was not registered");
    let getterCalls = 0;
    const getter = Object.defineProperty({}, "unknown", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });

    for (const [index, params] of [null, [], getter, { unknown: true }].entries())
      await expect(catalog.execute(`invalid-${index}`, params, undefined, undefined, {} as never)).rejects.toThrow(/parameters/iu);

    expect(getterCalls).toBe(0);
    expect(catalog.parameters).toMatchObject({ additionalProperties: false, properties: {} });
  });

  test("reports malformed catalog entries without hiding valid assets or absolute workspace paths", async () => {
    const { context, cwd, tools, panels } = await fixture();
    await writeFile(join(cwd, "bad.png"), "not a PNG", "utf8");
    await writeFile(join(cwd, "good.png"), png(80, 45));
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    if (catalog === undefined) throw new Error("vision_catalog was not registered");

    const result = await catalog.execute("catalog", {}, undefined, undefined, {} as never);

    const details = asRecord(result.details);
    expect(details.assets).toMatchObject([{ path: "good.png", width: 80, height: 45 }]);
    expect(Array.isArray(details.issues)).toBe(true);
    if (!Array.isArray(details.issues)) throw new Error("Expected catalog issues to be an array");
    const issue = asRecord(details.issues[0]);
    expect(issue.path).toBe("bad.png");
    expect(typeof issue.reason).toBe("string");
    if (typeof issue.reason !== "string") throw new Error("Expected a catalog issue reason");
    expect(issue.reason).toMatch(/bytes do not match/iu);
    expect(details.truncated).toBe(false);
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("Expected Vision Toolkit Agent content to be text");
    expect(content.text).toMatch(/1 image issue/iu);
    expect(JSON.stringify(result)).not.toContain(cwd);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { report: { issues: [{ path: "bad.png" }] } } }]);
  });

  test("bounds catalog text sent to the Agent on a valid UTF-8 boundary", async () => {
    const { context, cwd, tools } = await fixture();
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => writeFile(join(cwd, `${String(index).padStart(3, "0")}-${"界".repeat(70)}.png`), png(16, 9))),
    );
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    if (catalog === undefined) throw new Error("vision_catalog was not registered");

    const result = await catalog.execute("catalog", {}, undefined, undefined, {} as never);
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("expected catalog text");

    expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(16 * 1_024);
    expect(content.text).toContain("metadata truncated");
    expect(content.text).not.toContain("�");
  });

  test("bounds malformed image candidates and issue details", async () => {
    const { context, cwd, tools } = await fixture();
    await Promise.all(Array.from({ length: 257 }, async (_, index) => writeFile(join(cwd, `${String(index).padStart(3, "0")}.png`), "not a PNG", "utf8")));
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    if (catalog === undefined) throw new Error("vision_catalog was not registered");

    const result = await catalog.execute("catalog", {}, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({
      assets: [],
      inspectedCandidates: 256,
      issuesTruncated: true,
      truncated: true,
    });
    expect((result.details as { issues: unknown[] }).issues).toHaveLength(20);
  });

  test("bounds non-image directory entries before catalog discovery can grow without limit", async () => {
    const { context, cwd, tools } = await fixture();
    for (let offset = 0; offset < 4_097; offset += 256) {
      await Promise.all(
        Array.from({ length: Math.min(256, 4_097 - offset) }, async (_, index) =>
          writeFile(join(cwd, `${String(offset + index).padStart(4, "0")}.txt`), "", "utf8"),
        ),
      );
    }
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    if (catalog === undefined) throw new Error("vision_catalog was not registered");

    await expect(catalog.execute("catalog", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { assets: [], scannedEntries: 4_096, scannedDirectories: 1, truncated: true },
    });
  });

  test("bounds the number of valid assets returned by a catalog", async () => {
    const { context, cwd, tools } = await fixture();
    await Promise.all(Array.from({ length: 101 }, async (_, index) => writeFile(join(cwd, `${String(index).padStart(3, "0")}.png`), png(16, 9))));
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    if (catalog === undefined) throw new Error("vision_catalog was not registered");

    const result = await catalog.execute("catalog", {}, undefined, undefined, {} as never);

    expect((result.details as { assets: unknown[] }).assets).toHaveLength(100);
    expect(result.details).toMatchObject({ inspectedCandidates: 100, truncated: true });
  });

  test("escapes control and bidi characters in Agent-facing image paths", async () => {
    const { context, cwd, tools } = await fixture();
    const path = "diagram\u202e.png";
    await writeFile(join(cwd, path), png(16, 9));
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    const info = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_image_info");
    if (catalog === undefined || info === undefined) throw new Error("vision toolkit tools were not registered");

    const catalogResult = await catalog.execute("catalog", {}, undefined, undefined, {} as never);
    const infoResult = await info.execute("info", { path }, undefined, undefined, {} as never);
    const texts = [catalogResult.content[0], infoResult.content[0]].map((content) => (content?.type === "text" ? content.text : ""));

    for (const text of texts) {
      expect(text).toContain("Untrusted workspace image metadata");
      expect(text).toContain("\\u202e");
      expect(text).not.toMatch(/\p{Cf}/u);
      expect(
        [...text].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint <= 0x09 || (codePoint >= 0x0b && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f));
        }),
      ).toBe(false);
    }
  });

  test("publishes an explicit bounded panel contract and unregisters every surface on dispose", async () => {
    const { context, tools, panels } = await fixture();
    await context.plugin(visionToolkitPlugin, {});

    await expect(panels.snapshot()).resolves.toMatchObject([
      {
        id: "vision-toolkit-panel",
        data: {
          status: { state: "idle" },
          report: null,
          supportedTypes: ["gif", "jpeg", "jpg", "png", "webp"],
          limits: {
            imageBytes: 20_971_520,
            pathCharacters: 4_096,
            assets: 100,
            scannedEntries: 4_096,
            scannedDirectories: 512,
            depth: 16,
            issues: 20,
            issueCharacters: 500,
            agentTextBytes: 16_384,
          },
        },
      },
    ]);

    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("cancels an in-flight catalog when the plugin is disposed", async () => {
    const { context, cwd, tools, panels } = await fixture();
    for (let index = 0; index < 513; index += 1) await mkdir(join(cwd, `scan-${String(index).padStart(3, "0")}`));
    await context.plugin(visionToolkitPlugin, {});
    const catalog = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_catalog");
    if (catalog === undefined) throw new Error("vision_catalog was not registered");

    const execution = catalog.execute("catalog", {}, undefined, undefined, {} as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { status: { state: "running", operation: "catalog" } } }]);
    await context.fiber.dispose();

    await expect(execution).rejects.toThrow(/cancelled/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("bounds and sanitizes image-info failures without leaking the absolute workspace path", async () => {
    const { context, cwd, tools, panels } = await fixture();
    await context.plugin(visionToolkitPlugin, {});
    const info = tools.snapshot().customTools.find((candidate) => candidate.name === "vision_image_info");
    if (info === undefined) throw new Error("vision_image_info was not registered");
    let failure: unknown;

    try {
      await info.execute("missing", { path: "missing\u202e.png" }, undefined, undefined, {} as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message.length).toBeLessThanOrEqual(500);
    expect((failure as Error).message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect((failure as Error).message).not.toContain(cwd);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    const status = asRecord(asRecord((await panels.snapshot())[0]?.data).status);
    expect(status).toMatchObject({ state: "failed", operation: "info" });
    expect(typeof status.error).toBe("string");
    if (typeof status.error !== "string") throw new Error("Expected a failure error in the panel status");
    expect(status.error).not.toContain(cwd);
  });
});
