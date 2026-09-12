import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { readWorkspaceGitStatus } from "../src/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace git status", () => {
  test("reads branch and untracked files from a real git repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-git-status-"));
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: directory });
    await writeFile(join(directory, "notes.md"), "hello\n", "utf8");

    await expect(readWorkspaceGitStatus(directory)).resolves.toEqual({
      available: true,
      failureReason: null,
      branch: "main",
      clean: false,
      entries: [{ path: "notes.md", status: "??" }],
      truncated: false,
      changedCount: 1,
    });
  });

  test("preserves Unicode and newline filenames and rename pairs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-git-names-"));
    temporaryDirectories.push(directory);
    const git = (args: string[]) => execFileAsync("git", args, { cwd: directory });
    await git(["init", "-q", "-b", "main"]);
    await writeFile(join(directory, "before.txt"), "tracked");
    await git(["add", "."]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "initial"]);
    await git(["mv", "before.txt", "after.txt"]);
    await writeFile(join(directory, "中文\nname.txt"), "untracked");
    const result = await readWorkspaceGitStatus(directory);
    expect(result.entries).toContainEqual({ path: "after.txt", status: "R ", originalPath: "before.txt" });
    expect(result.entries).toContainEqual({ path: "中文\nname.txt", status: "??" });
  });

  test("limits status to the active workspace inside a parent repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-git-subtree-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "services", "orders");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(directory, "services", "billing"), { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: directory });
    await writeFile(join(workspace, "orders.ts"), "inside\n");
    await writeFile(join(directory, "services", "billing", "billing.ts"), "outside\n");

    await expect(readWorkspaceGitStatus(workspace)).resolves.toEqual({
      available: true,
      failureReason: null,
      branch: "main",
      clean: false,
      entries: [{ path: "orders.ts", status: "??" }],
      changedCount: 1,
      truncated: false,
    });
  });

  test("returns an unavailable report outside git", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-not-git-"));
    temporaryDirectories.push(directory);

    await expect(readWorkspaceGitStatus(directory)).resolves.toMatchObject({
      available: false,
      failureReason: "not-repository",
      branch: null,
      clean: false,
      entries: [],
    });
  });

  test("returns unavailable after the configured timeout when Git hangs", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-git-timeout-"));
    temporaryDirectories.push(directory);
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 1\n", "utf8");
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      await expect(readWorkspaceGitStatus(directory, 500)).resolves.toMatchObject({
        available: false,
        failureReason: "timeout",
        branch: null,
        clean: false,
        entries: [],
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("bounds serialized Git evidence while retaining the total changed count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-git-budget-"));
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: directory });
    await Promise.all(
      Array.from({ length: 500 }, (_, index) => writeFile(join(directory, `${String(index).padStart(3, "0")}-${'"'.repeat(220)}.txt`), "untracked")),
    );

    const result = await readWorkspaceGitStatus(directory);

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(128 * 1024);
    expect(result).toMatchObject({ available: true, changedCount: 500, truncated: true });
    expect(result.entries.length).toBeLessThan(500);
  });

  test("does not invent replacement-character paths for undecodable Git output", async () => {
    const { parseWorkspaceGitStatusOutput } = await import("../src/index.js");
    const output = Buffer.concat([Buffer.from("?? invalid-"), Buffer.from([0xff]), Buffer.from("\0")]);

    expect(parseWorkspaceGitStatusOutput(output)).toEqual({ entries: [], changedCount: 1, truncated: true });
  });
});
