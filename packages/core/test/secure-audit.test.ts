import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { auditText, auditWorkspace, summarizeAudit } from "../src/plugins/secure-audit.js";

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
