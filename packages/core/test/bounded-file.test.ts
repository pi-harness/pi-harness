import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readBoundedFile, readBoundedTextFile } from "../src/bounded-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bounded file reads", () => {
  test("reads a regular file through one bounded file handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-bounded-file-"));
    temporaryDirectories.push(root);
    const path = join(root, "input.txt");
    await writeFile(path, "hello", "utf8");

    await expect(readBoundedTextFile(path, 5, "Input file")).resolves.toBe("hello");
    await expect(readBoundedFile(path, 5, "Input file")).resolves.toEqual(Buffer.from("hello"));
  });

  test("rejects a file larger than its hard byte limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-bounded-file-"));
    temporaryDirectories.push(root);
    const path = join(root, "input.txt");
    await writeFile(path, "123456", "utf8");

    await expect(readBoundedTextFile(path, 5, "Input file")).rejects.toThrow(/Input file exceeds the 5-byte limit/iu);
  });

  test("rejects directories and symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-bounded-file-"));
    temporaryDirectories.push(root);
    const directory = join(root, "directory");
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await mkdir(directory);
    await writeFile(target, "secret", "utf8");
    await symlink(target, link);

    await expect(readBoundedFile(directory, 100, "Input file")).rejects.toThrow(/regular file/iu);
    await expect(readBoundedFile(link, 100, "Input file")).rejects.toThrow(/symbolic link/iu);
  });

  test("rejects invalid UTF-8 instead of returning replacement characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-bounded-file-"));
    temporaryDirectories.push(root);
    const path = join(root, "invalid.txt");
    await writeFile(path, Buffer.from([0xc3, 0x28]));

    await expect(readBoundedTextFile(path, 5, "Input file")).rejects.toThrow(/valid UTF-8/iu);
  });
});
