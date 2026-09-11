import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

describe("pih-local launcher", () => {
  test("builds, prefers the local server entrypoint, and cleans up its shim", () => {
    const directory = mkdtempSync(join(tmpdir(), "pih-local-test-"));
    const fakeBin = join(directory, "bin");
    const marker = join(directory, "marker.json");
    const fakeNpm = join(fakeBin, "npm");
    const fakeEveryApi = join(fakeBin, "everyapi");
    try {
      rmSync(fakeBin, { recursive: true, force: true });
      mkdirSync(fakeBin);
      writeFileSync(fakeNpm, '#!/bin/sh\nprintf build > "$PIH_LOCAL_MARKER.build"\n');
      writeFileSync(
        fakeEveryApi,
        `#!/usr/bin/env node
import { writeFileSync, existsSync } from "node:fs";
const path = process.env.PATH.split(":")[0];
writeFileSync(process.env.PIH_LOCAL_MARKER, JSON.stringify({ localShim: existsSync(path + "/pi-harness"), path }));
process.exit(7);
`,
      );
      chmodSync(fakeNpm, 0o755);
      chmodSync(fakeEveryApi, 0o755);
      const result = spawnSync("sh", [join(process.cwd(), "scripts", "pih-local.sh")], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          EVERYAPI_CLI_PATH: fakeEveryApi,
          PIH_LOCAL_MARKER: marker,
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(7);
      expect(readFileSync(`${marker}.build`, "utf8")).toBe("build");
      const invocation = JSON.parse(readFileSync(marker, "utf8")) as { localShim: boolean; path: string };
      expect(invocation.localShim).toBe(true);
      expect(invocation.path).not.toBe(fakeBin);
      expect(() => readFileSync(join(invocation.path, "pi-harness"))).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
