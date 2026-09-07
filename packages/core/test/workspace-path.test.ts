import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { prepareWorkspaceFile, resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace path boundaries", () => {
  test("rejects reads and writes that escape through a workspace symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workspace-path-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-workspace-path-outside-"));
    temporaryDirectories.push(root, outside);
    await writeFile(join(outside, "secret.txt"), "outside\n", "utf8");
    await symlink(outside, join(root, "linked"));

    await expect(resolveExistingWorkspacePath(root, "linked/secret.txt", "must stay inside")).rejects.toThrow(/must stay inside/);
    await expect(prepareWorkspaceFile(root, "linked/export.md", "must stay inside")).rejects.toThrow(/must stay inside/);
    await expect(readFile(join(outside, "export.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("prepares a new nested regular file inside the canonical workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workspace-path-"));
    temporaryDirectories.push(root);

    const prepared = await prepareWorkspaceFile(root, "reports/session.md", "must stay inside");

    expect(prepared).toMatchObject({ relativePath: "reports/session.md", exists: false });
  });
});
