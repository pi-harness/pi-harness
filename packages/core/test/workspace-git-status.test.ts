import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { readWorkspaceGitStatus } from "../src/plugins/workspace-navigator.js";

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
      branch: "main",
      clean: false,
      entries: [{ path: "notes.md", status: "??" }],
    });
  });

  test("returns an unavailable report outside git", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-not-git-"));
    temporaryDirectories.push(directory);

    await expect(readWorkspaceGitStatus(directory)).resolves.toMatchObject({ available: false, branch: null, clean: false, entries: [] });
  });
});
