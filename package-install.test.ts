import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("global package install contract", () => {
  test("does not run the workspace build from npm prepare", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.prepare).not.toBe("npm run build:web");
    expect(existsSync(join(root, "apps/web/server-dist/bin.js"))).toBe(true);
    expect(existsSync(join(root, "apps/web/dist/index.html"))).toBe(true);
  });

  test("keeps the Git package manifest and generated web entrypoint in npm packs", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      private?: boolean;
      files?: string[];
      scripts?: Record<string, string>;
    };
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/u);
    expect(gitignore).not.toContain("package.json");
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.scripts?.prepack).toBe("npm run build:web");
    expect(packageJson.files).toEqual(expect.arrayContaining(["apps/web", "packages"]));
  });
});
