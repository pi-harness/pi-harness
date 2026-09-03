import { describe, expect, test } from "vitest";
import { auditText, summarizeAudit } from "../src/plugins/secure-audit.js";

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
});
