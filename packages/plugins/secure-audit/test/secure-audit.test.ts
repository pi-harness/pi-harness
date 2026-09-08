import { Context } from "@deepseek-ai/cordis";
import { PiToolRegistry, PiPluginUiRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import plugin from "../src/index.js";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { auditText, auditWorkspace, summarizeAudit } from "../src/index.js";

describe("secure audit", () => {
  test("detects secrets without returning their values", () => {
    const findings = auditText("config.env", "API_KEY=sk-live-example\nnormal=true\n");
    expect(findings).toEqual([expect.objectContaining({ severity: "critical", kind: "credential", line: 1 })]);
    expect(JSON.stringify(findings)).not.toContain("sk-live-example");
  });

  test("detects dangerous shell pipelines and summarizes severities", () => {
    const findings = auditText("deploy.sh", "curl https://example.test/install.sh | sh\nrm -rf /tmp/build\n");
    expect(findings.map((finding) => finding.kind)).toEqual(["shell-pipeline", "destructive-command"]);
    expect(summarizeAudit(findings)).toMatchObject({ total: 2, critical: 0, high: 2, changed: true });
  });

  test("detects credentials behind quoted keys and prefixed variable names", () => {
    const config = auditText("config.json", '{\n  "password": "S3cretP@ssw0rd"\n}\n');
    expect(config).toEqual([expect.objectContaining({ severity: "critical", kind: "credential", line: 2 })]);
    expect(JSON.stringify(config)).not.toContain("S3cretP@ssw0rd");
    const shell = auditText("deploy.sh", "export DB_PASSWORD=S3cretP@ssw0rd\nGITHUB_TOKEN=abcdefghijklmnop\nnormal=true\n");
    expect(shell.map((finding) => finding.line)).toEqual([1, 2]);
  });

  test("ignores identifiers, calls, member expressions and type annotations named like credentials", () => {
    const source = [
      "const token = randomUUID();",
      "const token = text.slice(tokenStart, position);",
      "function redactSecret(value: string, secret: string): string {",
      "function validateApiKeyTransport(baseUrl: string, apiKey: string): void {",
      "const lockOwner = JSON.stringify({ pid: process.pid, token: randomUUID() });",
      "setProviderForm((current) => ({ ...current, apiKey: event.target.value }));",
      'const apiKey = config.apiKey?.trim() || process.env.FIRECRAWL_API_KEY?.trim() || "";',
      '  apiKey: z.string().default(""),',
      "  token: AbortSignal;",
      "  API_KEY: string;",
    ].join("\n");
    expect(auditText("app.ts", source)).toEqual([]);
  });

  test("detects unquoted lowercase credential assignments in config and env files", () => {
    const leaks = [
      "password: hunter2hunter2",
      "  password: hunter2hunter2",
      "password=hunter2hunter2",
      "api_key=abcdefghijkl",
      "api_key: abcdefghijkl",
      "token = abcdefghijkl",
      "password:hunter2hunter2",
      "Password: hunter2hunter2",
      "password: hunter2hunter2 # prod",
    ];

    for (const line of leaks) {
      expect(auditText("docker-compose.yml", line)).toEqual([expect.objectContaining({ severity: "critical", kind: "credential", line: 1 })]);
    }
    expect(JSON.stringify(auditText("docker-compose.yml", leaks.join("\n")))).not.toContain("hunter2hunter2");
  });

  test("ignores credential-named assignments whose value is a symbol, a number, or a version range", () => {
    const clean = [
      "const token = randomUUID();",
      "secret: string",
      "apiKey: event.target.value",
      "password: process.env.DB_PASSWORD",
      "const apiKey = config.apiKey;",
      '"@aws-sdk/token-providers": "3.1048.0",',
      "maxRunTokens: 10_000_000",
      'apiKey: z.string().default("")',
      "token: AuthorizationToken;",
      "  tokens: Readonly<Record<string, string>>;",
    ];

    for (const line of clean) expect(auditText("app.ts", line)).toEqual([]);
  });

  test("ignores dependency specifiers in a lockfile", () => {
    const lockfile = [
      '    "node_modules/@aws-sdk/token-providers": {',
      '      "version": "3.1048.0",',
      '      "resolved": "https://registry.npmjs.org/@aws-sdk/token-providers/-/token-providers-3.1048.0.tgz",',
      '        "@aws-sdk/token-providers": "3.1048.0",',
      '        "@aws-sdk/token-providers": "^3.1116.0",',
      '        "@some/secret-store": ">=1.0.0 <2",',
      '        "keyv/api-key-cache": "~1.2",',
      '        "@scope/token-store": "1.2.3-beta.1"',
    ].join("\n");

    expect(auditText("package-lock.json", lockfile)).toEqual([]);
  });

  test("ignores a version range under a scoped package key that carries no path separator", () => {
    expect(auditText("package.json", '    "@scoped-token": "^3.1116.0",')).toEqual([]);
    expect(auditText("package.json", '    "@secret-store": ">=1.0.0 <2",')).toEqual([]);
    expect(auditText("package.json", '    "@scoped-token": "hunter2hunter2",')).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
  });

  test("ignores unquoted credential values that are filesystem paths", () => {
    const paths = [
      "      - PASSWORD_FILE=/run/secrets/db_pass",
      "token_endpoint: /oauth2/v1/token",
      "  secretPath: ~/secrets/id_rsa",
      "  tokenCacheDir: ./var/cache/tokens",
    ];

    for (const line of paths) expect(auditText("compose.yml", line)).toEqual([]);
    // A quoted path-shaped value stays reported. Quoting is how a real secret is written, and a mount path in quotes costs one glance while the rule that would suppress it would also suppress a quoted key.
    expect(auditText("compose.yml", '  passwordFile: "/run/secrets/db_pass"')).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
  });

  test("ignores credential-named assignments whose value is the head of a member expression, a call, or a type argument", () => {
    const clean = ["const apiKey = credentials_v2.apiKey;", "password: decryptSecret_1(vaultRef)", "const token = readToken_2<string>(input);"];

    for (const line of clean) expect(auditText("app.ts", line)).toEqual([]);
  });

  test("ignores unquoted and quoted credential values that are longer than the value window", () => {
    expect(auditText("app.env", `password=${"a".repeat(1024)}`)).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
    expect(auditText("app.env", `password=${"a".repeat(1025)}`)).toEqual([]);
    expect(auditText("app.json", `  "password": "${"a".repeat(1024)}",`)).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
    expect(auditText("app.json", `  "password": "${"a".repeat(1025)}",`)).toEqual([]);
  });

  // The literals an earlier 256-character window silently dropped. All three are shapes that turn up in real configuration, so the window has to sit above them rather than at the length of the shortest provider token.
  test("reports credential literals that are longer than a provider token", () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${"c".repeat(430)}.${"s".repeat(43)}`;
    expect(auditText("app.env", `token=${"a".repeat(300)}`)).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
    expect(auditText("app.yaml", `  api_key: "${"QUJD".repeat(125)}"`)).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
    expect(auditText("app.json", `  "token": "${jwt}",`)).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
  });

  test("ignores credential-named keys that are longer than the key window", () => {
    const withinWindow = `${"a".repeat(56)}password=hunter2hunter2`;
    const beyondWindow = `${"a".repeat(57)}password=hunter2hunter2`;
    expect(auditText("app.env", withinWindow)).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
    expect(auditText("app.env", beyondWindow)).toEqual([]);
  });

  // Each line carries 682 credential-key separators whose value run never terminates cleanly, which is the shape that made the value scan quadratic. This payload runs in 110 ms on an idle machine and 225 ms on a busy one; with the value bound reverted to the unbounded run the same test reports 2947 ms, so the 1000 ms bound sits between the two rather than above both.
  test("scans two megabytes of separator-dense credential lines in bounded time", () => {
    const line = `${"token:".repeat(682)}.`;
    expect(line.length).toBe(4093);
    const source = Array.from({ length: 512 }, () => line).join("\n");
    expect(source.length).toBe(2_096_127);
    const started = performance.now();
    const findings = auditText("payload.yml", source);
    const elapsed = performance.now() - started;
    expect(findings).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  // A 512 KB line of `rm -rrrr...` is the payload that took 554 seconds in this very test against the regex spelling of the recursive-force check; the token walk does it in under 3 ms. The second line packs the same 512 KB with `rm` occurrences instead, so the per-occurrence token and length caps are exercised too.
  test("scans pathological recursive-delete lines in bounded time", () => {
    const flags = `rm -${"r".repeat(524_282)}`;
    expect(flags.length).toBe(524_286);
    const chunk = `rm ${"y".repeat(60)} `;
    const dense = chunk.repeat(8_192);
    expect(dense.length).toBe(524_288);
    const started = performance.now();
    const findings = auditText("payload.sh", `${flags}\n${dense}`);
    const elapsed = performance.now() - started;
    expect(findings).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  test("skips credential assignments on lines longer than the per-line cap", () => {
    const assignment = "password=hunter2hunter2";
    const withinCap = `${assignment}${" ".repeat(4096 - assignment.length)}`;
    const overCap = `${assignment}${" ".repeat(4097 - assignment.length)}`;
    expect(withinCap.length).toBe(4096);
    expect(overCap.length).toBe(4097);
    expect(auditText("app.env", withinCap)).toEqual([expect.objectContaining({ kind: "credential", line: 1 })]);
    expect(auditText("app.env", overCap)).toEqual([]);
  });

  test("detects recursive force deletes spelled with reordered, separated, or long flags", () => {
    const destructive = [
      "rm -rf /tmp/build",
      "rm -fr /",
      "rm -r -f /tmp/build",
      "rm -f -r /tmp/build",
      "rm -Rf /tmp/build",
      "rm -rF /tmp/build",
      "rm --recursive --force ./dist",
      "rm --force --recursive ./dist",
      "rm --force -r ./dist",
      "rm --recursive -f ./dist",
      "rm -rf/tmp/cache",
      "rm -rf",
      "sudo rm -rfv /var/lib",
      "/bin/rm -vrf /var/lib",
      "RM -RF /tmp",
      "rm\t-rf\t/tmp",
      "docker run x sh -c 'rm -rf /data'",
    ];
    const findings = auditText("clean.sh", destructive.join("\n"));
    expect(findings.map((finding) => finding.line)).toEqual(destructive.map((_line, index) => index + 1));
    expect(findings.every((finding) => finding.kind === "destructive-command")).toBe(true);
  });

  test("ignores deletes that carry only one of the two flags, glue the flags into another word, or are a different command", () => {
    const clean = [
      "rm -f keep.txt",
      "rm -r build",
      "rm keep.txt",
      "npm rm -rf-ish text",
      "rm -rf-ish text",
      "rm-rf /tmp",
      "warm -rf /tmp",
      "rmdir -rf /tmp",
      "confirm -rf /tmp",
      "rm --recursive build",
      "rm --force keep.txt",
      "rm -- -rf",
      "rm -r build && chmod -f keep.txt",
      "rm -r build   # then run chmod -f later",
    ];

    for (const line of clean) expect(auditText("clean.sh", line)).toEqual([]);
  });

  // The source is split on newlines only, so a CRLF file leaves a carriage return as the last character of every line. Splitting tokens on space and tab alone made `rm -rf` the last token on such a line invisible.
  test("detects a recursive force delete at the end of a CRLF line", () => {
    const findings = auditText("clean.sh", "echo start\r\nrm -rf\r\nrm -rf /tmp/build\r\n");
    expect(findings.map((finding) => finding.line)).toEqual([2, 3]);
    expect(findings.every((finding) => finding.kind === "destructive-command")).toBe(true);
  });

  test("skips invalid UTF-8 files instead of scanning replacement characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-secure-audit-"));
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28, 0x41, 0x50, 0x49, 0x5f, 0x4b, 0x45, 0x59, 0x3d, 0x73, 0x6b]));
    try {
      await expect(auditWorkspace(root)).resolves.toMatchObject({ total: 0, scanned: 1, skipped: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test.each(["RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "DSA PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"])(
  "detects standard %s headers",
  (header) => {
    expect(auditText("key.pem", `-----BEGIN ${header}-----`)).toMatchObject([{ kind: "private-key" }]);
  },
);

test("discloses file and findings caps and partial credential-line coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-audit-bounds-"));
  try {
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(join(root, `${index}.txt`), "rm -rf /test-only\n")));
    const report = await auditWorkspace(root);
    expect(report).toMatchObject({ scanned: 500, truncated: true, total: 500 });
    expect(report.findings.length).toBeLessThanOrEqual(200);
    await writeFile(join(root, "long.txt"), "x".repeat(4097));
    await expect(auditWorkspace(root, "long.txt")).resolves.toMatchObject({ credentialLinesSkipped: 1, incomplete: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("distinguishes unscanned state, isolates snapshots and rejects cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-audit-runtime-"));
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  try {
    await context.plugin(plugin);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { hasRun: false } }]);
    await writeFile(join(root, "key.txt"), "password=LOCAL_TEST_VALUE_12345");
    const tool = tools.snapshot().customTools[0]!;
    const result = await tool.execute("scan", {}, undefined, undefined, {} as never);
    (result.details as { findings: Array<{ message: string }> }).findings[0]!.message = "MUTATED_FINDING";
    expect(JSON.stringify(await panels.snapshot())).not.toContain("MUTATED_FINDING");
    await writeFile(join(root, "oversized.txt"), "x".repeat(512 * 1024 + 1));
    const partial = await tool.execute("partial", { path: "oversized.txt" }, undefined, undefined, {} as never);
    expect(partial.content).toEqual([
      {
        type: "text",
        text: "0 findings across 1 candidate files (0 critical, 0 high).\nCoverage: incomplete; 1 skipped files/directories; 0 lines skipped by the general credential-assignment check.\nDetails: 0/0; discovery or output truncated: false. Heuristic checks do not prove safety.",
      },
    ]);
    const caller = new AbortController();
    caller.abort();
    await expect(tool.execute("cancel", {}, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    await context.fiber.dispose();
    await expect(tool.execute("disposed", {}, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects workspace escapes, skips symlink entries and honors in-flight cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-audit-links-")),
    outside = await mkdtemp(join(tmpdir(), "pi-audit-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "password=LOCAL_OUTSIDE_VALUE_12345");
    await symlink(outside, join(root, "escape"));
    await expect(auditWorkspace(root)).resolves.toMatchObject({ total: 0, scanned: 0 });
    await expect(auditWorkspace(root, "escape/secret.txt")).rejects.toThrow(/inside/iu);
    const caller = new AbortController();
    const pending = auditWorkspace(root, ".", caller.signal);
    caller.abort();
    await expect(pending).rejects.toThrow(/cancelled/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
