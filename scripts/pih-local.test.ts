import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

describe("pih-local launcher", () => {
  test("prints help without building or invoking EveryAPI", () => {
    const directory = mkdtempSync(join(tmpdir(), "pih-local-help-test-"));
    const fakeBin = join(directory, "bin");
    const marker = join(directory, "build-invoked");
    const fakeNpm = join(fakeBin, "npm");
    try {
      mkdirSync(fakeBin);
      writeFileSync(fakeNpm, '#!/bin/sh\nprintf invoked > "$PIH_LOCAL_MARKER"\nexit 42\n');
      chmodSync(fakeNpm, 0o755);

      const result = spawnSync("sh", [join(process.cwd(), "scripts", "pih-local.sh"), "--help"], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, PIH_LOCAL_MARKER: marker },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("builds and makes the authenticated pi-harness launcher run the local server", () => {
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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const shim = process.env.PATH.split(":")[0];
writeFileSync(process.env.PIH_LOCAL_MARKER, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  serverEntry: process.env.PIH_LOCAL_SERVER_ENTRY,
  codingAgentDir: process.env.PI_CODING_AGENT_DIR,
  wrapper: readFileSync(join(shim, "pi-harness"), "utf8"),
}));
process.exit(7);
`,
      );
      chmodSync(fakeNpm, 0o755);
      chmodSync(fakeEveryApi, 0o755);
      const launchDir = join(directory, "product");
      mkdirSync(launchDir);
      const result = spawnSync("sh", [join(process.cwd(), "scripts", "pih-local.sh"), "--smoke"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          EVERYAPI_CLI_PATH: fakeEveryApi,
          PI_AGENT_DIR: join(directory, "agent"),
          PIH_LOCAL_CWD: launchDir,
          PIH_LOCAL_MARKER: marker,
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(7);
      expect(readFileSync(`${marker}.build`, "utf8")).toBe("build");
      const invocation = JSON.parse(readFileSync(marker, "utf8")) as {
        args: string[];
        cwd?: string;
        serverEntry?: string;
        codingAgentDir?: string;
        wrapper: string;
      };
      expect(invocation.cwd).toBe(realpathSync(launchDir));
      expect(invocation.serverEntry).toBe(join(process.cwd(), "apps", "web", "server-dist", "bin.js"));
      expect(invocation.codingAgentDir).toBe(join(directory, "agent"));
      expect(invocation.wrapper).toContain('exec node "$PIH_LOCAL_SERVER_ENTRY" "$@"');
      // pi-harness is EveryAPI's tool for this product; pi-web is its integration for Pi's own browser UI, which would exec a shim of that name and never reach this checkout.
      expect(invocation.args).toEqual(["use", "pi-harness", "--", "--smoke"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
