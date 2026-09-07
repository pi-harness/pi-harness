import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { win32 } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import imageCompressorPlugin, { isImageCompressorPathInside } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-image-"));
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(imageCompressorPlugin);
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "image_compress");
  if (tool === undefined) throw new Error("image_compress was not registered");
  return { root, context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("image compressor", () => {
  test("rejects Windows paths outside the workspace using native path semantics", () => {
    expect(isImageCompressorPathInside("C:\\repo", "C:\\outside", win32)).toBe(false);
    expect(isImageCompressorPathInside("C:\\repo", "C:\\repo\\asset.png", win32)).toBe(true);
  });

  test("losslessly recompresses a workspace PNG after confirmation", async () => {
    const { root, tool, panels } = await fixture();
    await writeFile(join(root, "input.png"), onePixelPng);
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    const result = await tool.execute("compress", { path: "input.png", outputPath: "out.png", confirm: true }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ inputPath: "input.png", outputPath: "out.png", format: "png", saved: true });
    expect((await stat(join(root, "out.png"))).isFile()).toBe(true);
    expect((await readFile(join(root, "out.png"))).subarray(0, 8)).toEqual(onePixelPng.subarray(0, 8));
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: { outputPath: "out.png" } } }]);
  });

  test("rejects unconfirmed or escaping writes and disposes registrations", async () => {
    const { root, context, tools, panels, tool } = await fixture();
    await writeFile(join(root, "input.png"), onePixelPng);
    await expect(tool.execute("no", { path: "input.png", confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await expect(tool.execute("escape", { path: "../input.png", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(/inside/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
  test("writes the default output next to the input and refuses to replace an existing derived file", async () => {
    const { root, tool } = await fixture();
    await mkdir(join(root, "assets", "icons"), { recursive: true });
    await mkdir(join(root, "docs", "img"), { recursive: true });
    await writeFile(join(root, "assets", "icons", "logo.png"), onePixelPng);
    await writeFile(join(root, "docs", "img", "logo.png"), onePixelPng);

    const first = await tool.execute("first", { path: "assets/icons/logo.png", confirm: true }, undefined, undefined, {} as never);
    expect(first.details).toMatchObject({ inputPath: join("assets", "icons", "logo.png"), outputPath: join("assets", "icons", "logo.min.png") });
    expect((await stat(join(root, "assets", "icons", "logo.min.png"))).isFile()).toBe(true);
    await expect(stat(join(root, "logo.min.png"))).rejects.toMatchObject({ code: "ENOENT" });

    const second = await tool.execute("second", { path: "docs/img/logo.png", confirm: true }, undefined, undefined, {} as never);
    expect(second.details).toMatchObject({ outputPath: join("docs", "img", "logo.min.png") });
    expect((await stat(join(root, "docs", "img", "logo.min.png"))).isFile()).toBe(true);
    expect((await stat(join(root, "assets", "icons", "logo.min.png"))).isFile()).toBe(true);

    await expect(tool.execute("again", { path: "assets/icons/logo.png", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
      /already exists.*assets\/icons\/logo\.min\.png.*outputPath/iu,
    );
    await expect(
      tool.execute("explicit", { path: "assets/icons/logo.png", outputPath: "assets/icons/logo.min.png", confirm: true }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ details: { outputPath: join("assets", "icons", "logo.min.png") } });
  });
});
