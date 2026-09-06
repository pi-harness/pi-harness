import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { atomicWriteFile } from "../src/atomic-write.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("atomicWriteFile", () => {
  test("does not create a target when its signal is already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-atomic-write-"));
    temporaryDirectories.push(root);
    const target = join(root, "target.txt");
    const controller = new AbortController();
    controller.abort(new Error("caller stopped atomic write"));

    await expect(atomicWriteFile(target, "content", { encoding: "utf8", signal: controller.signal })).rejects.toThrow(/caller stopped/iu);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
  });

  test("creates without replacement atomically under concurrent writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-atomic-write-"));
    temporaryDirectories.push(root);
    const target = join(root, "target.txt");

    const outcomes = await Promise.allSettled([
      atomicWriteFile(target, "first", { encoding: "utf8", overwrite: false }),
      atomicWriteFile(target, "second", { encoding: "utf8", overwrite: false }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(readFile(target, "utf8")).resolves.toMatch(/^(?:first|second)$/u);
    expect((await readdir(root)).filter((name) => name.startsWith(".target.txt.") && name.endsWith(".tmp"))).toEqual([]);
  });

  test("cleans its exclusive temporary file when the final rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-atomic-write-"));
    temporaryDirectories.push(root);
    const target = join(root, "target.txt");
    await mkdir(target);
    await mkdir(join(target, "child"));

    await expect(atomicWriteFile(target, "replacement", { encoding: "utf8", mode: 0o600 })).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.startsWith(".target.txt.") && name.endsWith(".tmp"))).toEqual([]);
  });
});
