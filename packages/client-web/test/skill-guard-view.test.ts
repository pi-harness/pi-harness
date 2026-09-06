import { describe, expect, it } from "vitest";
import { skillGuardPanelView } from "../src/skill-guard-view.js";

describe("Skill Guard view", () => {
  it("normalizes scan status, inventory, and reports", () => {
    expect(
      skillGuardPanelView({
        scans: 2,
        total: 2,
        blocked: 1,
        review: 1,
        reports: [
          {
            name: "unsafe",
            risk: "blocked",
            score: 5,
            findings: [{ code: "instruction_override", severity: "high", message: "Override detected" }],
            path: "/workspace/.agents/skills/unsafe/SKILL.md",
            source: "project",
            scannedBytes: 512,
          },
        ],
        status: { state: "completed", at: "2026-09-05T12:00:00.000Z" },
        inventory: { available: 2, scanned: 2, shown: 1, truncated: false, scanTruncated: false, displayTruncated: false },
        limits: {
          queryCharacters: 120,
          skillBytes: 131_072,
          skills: 50,
          panelReports: 20,
          nameCharacters: 64,
          sourceCharacters: 128,
          pathCharacters: 4_096,
          statusErrorCharacters: 2_000,
          findingsPerSkill: 6,
          findingCodeCharacters: 64,
          findingMessageCharacters: 256,
          score: 28,
        },
      }),
    ).toMatchObject({
      scans: 2,
      total: 2,
      blocked: 1,
      review: 1,
      reports: [
        {
          name: "unsafe",
          risk: "blocked",
          score: 5,
          findings: [{ code: "instruction_override", severity: "high", message: "Override detected" }],
          path: "/workspace/.agents/skills/unsafe/SKILL.md",
          source: "project",
          scannedBytes: 512,
        },
      ],
      status: { state: "completed", at: "2026-09-05T12:00:00.000Z", error: null },
      inventory: { available: 2, scanned: 2, shown: 1, truncated: false },
      limits: { skills: 50, panelReports: 20, findingsPerSkill: 6, score: 28 },
    });
  });

  it("enforces fixed browser caps on hostile nested data", () => {
    const long = "x".repeat(20_000);
    const report = {
      name: long,
      risk: "blocked",
      score: 9_999,
      findings: Array.from({ length: 20 }, () => ({ code: long, severity: "high", message: long })),
      path: long,
      source: long,
      scannedBytes: 9_999_999,
    };
    const view = skillGuardPanelView({
      scans: Number.MAX_SAFE_INTEGER + 1,
      total: 999,
      blocked: 999,
      review: 999,
      reports: Array.from({ length: 40 }, () => report),
      status: { state: "failed", at: "2026-09-05T12:01:00.000Z", error: long },
      inventory: { available: 999, scanned: 999, shown: 999, truncated: true, scanTruncated: true, displayTruncated: true },
      limits: Object.fromEntries(
        [
          "queryCharacters",
          "skillBytes",
          "skills",
          "panelReports",
          "nameCharacters",
          "sourceCharacters",
          "pathCharacters",
          "statusErrorCharacters",
          "findingsPerSkill",
          "findingCodeCharacters",
          "findingMessageCharacters",
          "score",
        ].map((key) => [key, 99_999_999]),
      ),
    });

    expect(view.scans).toBe(0);
    expect(view.total).toBe(0);
    expect(view.blocked).toBe(0);
    expect(view.review).toBe(0);
    expect(view.reports).toHaveLength(20);
    expect(view.reports[0]?.name).toHaveLength(64);
    expect(view.reports[0]?.source).toHaveLength(128);
    expect(view.reports[0]?.path).toHaveLength(4_096);
    expect(view.reports[0]?.score).toBe(0);
    expect(view.reports[0]?.scannedBytes).toBe(0);
    expect(view.reports[0]?.findings).toHaveLength(6);
    expect(view.reports[0]?.findings[0]?.code).toHaveLength(64);
    expect(view.reports[0]?.findings[0]?.message).toHaveLength(256);
    expect(view.status.error).toHaveLength(2_000);
    expect(view.inventory).toMatchObject({ available: 999, scanned: 0, shown: 0, truncated: true, scanTruncated: true, displayTruncated: true });
    expect(view.limits).toMatchObject({
      queryCharacters: 120,
      skillBytes: 131_072,
      skills: 50,
      panelReports: 20,
      nameCharacters: 64,
      sourceCharacters: 128,
      pathCharacters: 4_096,
      statusErrorCharacters: 2_000,
      findingsPerSkill: 6,
      findingCodeCharacters: 64,
      findingMessageCharacters: 256,
      score: 28,
    });
  });

  it("preserves a safe available count beyond the bounded scan window", () => {
    const view = skillGuardPanelView({
      inventory: { available: 55, scanned: 50, shown: 20, truncated: true, scanTruncated: true, displayTruncated: true },
      limits: { skills: 50, panelReports: 20 },
    });

    expect(view.inventory).toMatchObject({ available: 55, scanned: 50, shown: 20, truncated: true });
  });
});
