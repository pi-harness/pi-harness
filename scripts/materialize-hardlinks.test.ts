import { chmod, link, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("publish hard-link materialization", () => {
  test("turns hard-linked regular files into independent files without following symbolic links", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-harness-hardlinks-"));
    fixtures.push(fixture);
    const nested = join(fixture, "nested");
    await mkdir(nested);
    const first = join(nested, "binary-a");
    const second = join(nested, "binary-b");
    const symbolic = join(nested, "symbolic");
    await writeFile(first, "runtime-binary");
    await chmod(first, 0o755);
    await link(first, second);
    await symlink(first, symbolic);

    await execFileAsync(process.execPath, [resolve(repositoryRoot, "scripts/materialize-hardlinks.mjs"), fixture]);

    const [firstStats, secondStats, symbolicStats] = await Promise.all([stat(first), stat(second), lstat(symbolic)]);
    expect(firstStats.ino).not.toBe(secondStats.ino);
    expect(firstStats.nlink).toBe(1);
    expect(secondStats.nlink).toBe(1);
    expect(firstStats.mode & 0o777).toBe(0o755);
    expect(secondStats.mode & 0o777).toBe(0o755);
    expect(await readFile(first, "utf8")).toBe("runtime-binary");
    expect(await readFile(second, "utf8")).toBe("runtime-binary");
    expect(symbolicStats.isSymbolicLink()).toBe(true);
  });
});
