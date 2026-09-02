import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { catalogImages, imageInfo } from "../src/plugins/vision-toolkit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("vision toolkit", () => {
  test("catalogs supported workspace images with dimensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "designs"));
    const png = Buffer.alloc(24);
    png.write("\x89PNG\r\n\x1a\n", "binary");
    png.writeUInt32BE(320, 16);
    png.writeUInt32BE(180, 20);
    await writeFile(join(root, "designs", "hero.png"), png);
    await writeFile(join(root, "notes.txt"), "not an image");

    await expect(catalogImages(root)).resolves.toEqual([{ path: "designs/hero.png", mimeType: "image/png", bytes: 24, width: 320, height: 180 }]);
  });

  test("rejects image paths outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vision-toolkit-"));
    temporaryDirectories.push(root);
    await expect(imageInfo(root, "../outside.png")).rejects.toThrow(/inside the workspace/);
  });
});
