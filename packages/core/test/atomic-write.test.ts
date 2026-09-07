import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { atomicWriteFile } from "@pi-harness/plugin-api";
import type * as FsPromises from "node:fs/promises";

const temporaryDirectories: string[] = [];

// Records the order of fsync and rename calls made through node:fs/promises so the tests can prove the temporary file reaches stable storage before it replaces the target.
const durability = vi.hoisted(() => ({ sequence: [] as string[], failSync: false, failDirectoryOpen: false, failDirectorySync: false }));

function errno(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      // Only the post-rename directory fsync opens with the "r" flag; the temporary file uses "wx".
      const directoryOpen = args[1] === "r";
      if (directoryOpen && durability.failDirectoryOpen) throw errno("permission denied, open directory", "EACCES");
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const originalSync = handle.sync.bind(handle);
      Object.defineProperty(handle, "sync", {
        value: async () => {
          durability.sequence.push(`sync:${path}`);
          if (directoryOpen && durability.failDirectorySync) throw errno("input/output error, fsync", "EIO");
          if (durability.failSync) throw new Error("sync failed");
          await originalSync();
        },
      });
      return handle;
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      durability.sequence.push(`rename:${String(args[1])}`);
      await actual.rename(...args);
    },
  };
});

afterEach(async () => {
  durability.sequence.length = 0;
  durability.failSync = false;
  durability.failDirectoryOpen = false;
  durability.failDirectorySync = false;
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

  test("keeps the existing permission bits of the file it replaces", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-atomic-write-"));
    temporaryDirectories.push(root);
    const target = join(root, "build.sh");
    await writeFile(target, "old", "utf8");
    await chmod(target, 0o755);

    await atomicWriteFile(target, "new", { encoding: "utf8" });

    await expect(readFile(target, "utf8")).resolves.toBe("new");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  test("creates a new file privately and honours an explicit mode", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-atomic-write-"));
    temporaryDirectories.push(root);
    const created = join(root, "created.txt");
    const pinned = join(root, "pinned.txt");
    await writeFile(pinned, "old", "utf8");
    await chmod(pinned, 0o755);

    await atomicWriteFile(created, "content", { encoding: "utf8" });
    await atomicWriteFile(pinned, "content", { encoding: "utf8", mode: 0o600 });

    expect((await stat(created)).mode & 0o777).toBe(0o600);
    expect((await stat(pinned)).mode & 0o777).toBe(0o600);
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
  test("fsyncs the temporary file before the rename and the directory after it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-atomic-write-"));
    temporaryDirectories.push(root);
    const target = join(root, "target.txt");

    await atomicWriteFile(target, "durable", { encoding: "utf8" });

    await expect(readFile(target, "utf8")).resolves.toBe("durable");
    const fileSync = durability.sequence.findIndex((entry) => entry.startsWith(`sync:${join(root, ".target.txt.")}`) && entry.endsWith(".tmp"));
    const rename = durability.sequence.indexOf(`rename:${target}`);
    const directorySync = durability.sequence.indexOf(`sync:${root}`);
    expect(fileSync).toBeGreaterThanOrEqual(0);
    expect(rename).toBeGreaterThan(fileSync);
    expect(directorySync).toBeGreaterThan(rename);
  });

  test("keeps a committed write successful when the directory cannot be opened or fsynced", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-atomic-write-"));
    temporaryDirectories.push(root);
    const unopenable = join(root, "unopenable.txt");
    durability.failDirectoryOpen = true;

    await expect(atomicWriteFile(unopenable, "committed", { encoding: "utf8" })).resolves.toBeUndefined();
    await expect(readFile(unopenable, "utf8")).resolves.toBe("committed");

    durability.failDirectoryOpen = false;
    durability.failDirectorySync = true;
    const unsyncable = join(root, "unsyncable.txt");

    await expect(atomicWriteFile(unsyncable, "committed", { encoding: "utf8" })).resolves.toBeUndefined();
    await expect(readFile(unsyncable, "utf8")).resolves.toBe("committed");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("rejects and removes the temporary file when fsync fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-atomic-write-"));
    temporaryDirectories.push(root);
    const target = join(root, "target.txt");
    durability.failSync = true;

    await expect(atomicWriteFile(target, "content", { encoding: "utf8" })).rejects.toThrow(/sync failed/u);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
  });
});
