import { describe, expect, test } from "vitest";
import { testHarnessPanelView } from "../src/test-harness-view.js";

const allowedScripts = ["test", "build", "format:check", "lint", "typecheck"];

function report(latest: Record<string, unknown> | null): Record<string, unknown> {
  return { allowedScripts, latest, limits: { timeoutMs: 120_000, outputBytes: 12 * 1024 } };
}

describe("test harness panel view", () => {
  test("normalizes a validated run without marking it truncated", () => {
    const view = testHarnessPanelView(
      report({
        cwd: "/workspace/验证项目",
        script: "test",
        command: "npm run test",
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 321,
        output: "2 tests passed\n",
        outputBytes: 15,
        outputTruncated: false,
        outputSanitized: false,
      }),
    );

    expect(view.truncated).toBe(false);
    expect(view.latest).toEqual({
      cwd: "/workspace/验证项目",
      script: "test",
      command: "npm run test",
      status: "passed",
      exitCode: 0,
      signal: null,
      durationMs: 321,
      output: "2 tests passed\n",
      outputBytes: 15,
      outputTruncated: false,
      outputSanitized: false,
    });
    expect(view.limits).toEqual({ timeoutMs: 120_000, outputBytes: 12 * 1024 });
    expect(view.allowedScripts).toEqual(allowedScripts);
  });

  test("keeps a sanitized run that truncation pushed past the byte cap", () => {
    const view = testHarnessPanelView(
      report({
        cwd: "/workspace/验证项目",
        script: "test",
        command: "npm run test",
        status: "failed",
        exitCode: 1,
        signal: null,
        durationMs: 900,
        output: "progress\n",
        outputBytes: 5_000,
        outputTruncated: true,
        outputSanitized: true,
      }),
    );

    expect(view.truncated).toBe(false);
    expect(view.latest).toMatchObject({ status: "failed", exitCode: 1, outputBytes: 5_000, outputTruncated: true, outputSanitized: true });
  });

  test("keeps a run that decode-time expansion truncated with the raw counter below the cap", () => {
    // What the backend reports for 5000 raw bytes of invalid UTF-8: `raw.toString("utf8")` widens each one into a three-byte U+FFFD before the sanitiser sees it, so the bounded output fills the 12 KiB cap while `outputSanitized` stays false and the raw counter stays at 5000.
    const view = testHarnessPanelView(
      report({
        cwd: "/workspace/验证项目",
        script: "test",
        command: "npm run test",
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 900,
        output: "�".repeat((12 * 1024) / 3),
        outputBytes: 5_000,
        outputTruncated: true,
        outputSanitized: false,
      }),
    );

    expect(view.truncated).toBe(false);
    expect(view.latest).toMatchObject({ outputBytes: 5_000, outputTruncated: true, outputSanitized: false });
  });

  test("drops a truncated run whose output fills neither the byte cap nor the raw counter", () => {
    const view = testHarnessPanelView(
      report({
        cwd: "/workspace/验证项目",
        script: "test",
        command: "npm run test",
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 900,
        output: "progress\n",
        outputBytes: 5_000,
        outputTruncated: true,
        outputSanitized: false,
      }),
    );

    expect(view.latest).toBeNull();
    expect(view.truncated).toBe(true);
  });
});
