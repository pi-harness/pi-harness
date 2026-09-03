import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { renderReadme, writeReadmeFile } from "../src/plugins/readme-gen.js";

describe("readme generator", () => {
  test("renders scripts and active plugins as markdown", () => {
    expect(
      renderReadme({
        name: "demo",
        version: "1.2.3",
        description: "A demo project",
        scripts: ["build", "test"],
        plugins: ["@pi-harness/core/plugins/archify"],
      }),
    ).toBe(
      "# demo\n\nA demo project\n\nVersion: 1.2.3\n\n## Scripts\n\n- `npm run build`\n- `npm run test`\n\n## Runtime plugins\n\n- `@pi-harness/core/plugins/archify`\n",
    );
  });

  test("requires confirmation and writes inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-readme-"));
    try {
      await expect(writeReadmeFile(root, "# Demo\n", "README.generated.md", false)).rejects.toThrow(/confirm=true/);
      await expect(writeReadmeFile(root, "# Demo\n", "../outside.md", true)).rejects.toThrow(/inside the workspace/);
      await expect(writeReadmeFile(root, "# Demo\n", "docs/README.generated.md", true)).resolves.toMatchObject({
        path: "docs/README.generated.md",
        bytes: 7,
        overwritten: false,
      });
      await expect(readFile(join(root, "docs/README.generated.md"), "utf8")).resolves.toBe("# Demo\n");
      const outside = await mkdtemp(join(tmpdir(), "pi-harness-readme-outside-"));
      try {
        await writeFile(join(outside, "README.md"), "outside\n", "utf8");
        await symlink(join(outside, "README.md"), join(root, "README.link.md"));
        await expect(writeReadmeFile(root, "# Demo\n", "README.link.md", true)).rejects.toThrow(/symbolic link/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
