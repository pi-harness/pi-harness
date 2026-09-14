import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

describe("build-plugins", () => {
  test("ignores directories that do not contain a plugin manifest", () => {
    const fixture = mkdtempSync(join(tmpdir(), "build-plugins-test-"));
    try {
      mkdirSync(join(fixture, "scripts"));
      mkdirSync(join(fixture, "packages", "plugins", "valid"), { recursive: true });
      mkdirSync(join(fixture, "packages", "plugins", "migrated", "dist"), { recursive: true });
      copyFileSync(join(process.cwd(), "scripts", "build-plugins.mjs"), join(fixture, "scripts", "build-plugins.mjs"));
      writeFileSync(join(fixture, "packages", "plugins", "valid", "package.json"), JSON.stringify({ dependencies: {} }));

      const result = spawnSync(process.execPath, [join(fixture, "scripts", "build-plugins.mjs"), "--order"], {
        cwd: fixture,
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(join("packages", "plugins", "valid"));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
