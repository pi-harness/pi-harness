import { describe, expect, test } from "vitest";
import { yamlValidatorPanelView } from "../src/yaml-validator-view.js";

describe("YAML validator panel view", () => {
  test("normalizes a complete validation report and production limits", () => {
    expect(
      yamlValidatorPanelView({
        latest: {
          path: "config.yml",
          valid: false,
          bytes: 42,
          documents: 1,
          rootType: "map",
          errorCount: 1,
          warningCount: 1,
          diagnosticsTruncated: false,
          errors: [{ message: "broken mapping", code: "BAD_INDENT", line: 2, column: 3 }],
          warnings: [{ message: "warning", line: 1, column: 1 }],
        },
        status: { state: "completed", at: "2026-09-05T00:00:00Z" },
        inventory: {
          errors: { total: 1, shown: 1, truncated: false },
          warnings: { total: 1, shown: 1, truncated: false },
        },
        limits: {
          fileBytes: 524_288,
          pathCharacters: 4_096,
          documents: 100,
          diagnostics: 1_000,
          panelDiagnostics: 50,
          toolDiagnostics: 50,
          diagnosticMessageCharacters: 2_000,
          statusErrorCharacters: 2_000,
        },
      }),
    ).toEqual({
      cwd: "",
      latest: {
        path: "config.yml",
        valid: false,
        bytes: 42,
        documents: 1,
        rootType: "map",
        errorCount: 1,
        warningCount: 1,
        diagnosticsTruncated: false,
        errors: [{ message: "broken mapping", code: "BAD_INDENT", line: 2, column: 3 }],
        warnings: [{ message: "warning", line: 1, column: 1 }],
      },
      status: { state: "completed", at: "2026-09-05T00:00:00Z" },
      inventory: {
        errors: { total: 1, shown: 1, truncated: false },
        warnings: { total: 1, shown: 1, truncated: false },
      },
      limits: {
        fileBytes: 524_288,
        pathCharacters: 4_096,
        documents: 100,
        diagnostics: 1_000,
        panelDiagnostics: 50,
        toolDiagnostics: 50,
        diagnosticMessageCharacters: 2_000,
        statusErrorCharacters: 2_000,
      },
    });
  });

  test("bounds hostile fields and diagnostic arrays", () => {
    const long = "x".repeat(10_000);
    const view = yamlValidatorPanelView({
      latest: {
        path: long,
        valid: "yes",
        bytes: Number.POSITIVE_INFINITY,
        documents: 999,
        rootType: long,
        errorCount: 99_999,
        warningCount: 99_999,
        diagnosticsTruncated: false,
        errors: [null, ...Array.from({ length: 60 }, (_, index) => ({ message: `${index}-${long}`, code: long, line: -1, column: Number.NaN }))],
        warnings: Array.from({ length: 60 }, () => ({ message: long })),
      },
      status: { state: long, at: long, error: long },
      inventory: { errors: { total: 99_999 }, warnings: { total: 99_999 } },
      limits: {},
    });

    expect(view.latest?.path).toHaveLength(4_096);
    expect(view.latest).toMatchObject({ valid: false, bytes: 0, documents: 0, rootType: "unknown", diagnosticsTruncated: true });
    expect(view.latest?.errors).toHaveLength(20);
    expect(view.latest?.warnings).toHaveLength(0);
    expect(view.latest?.errors[0]?.message).toHaveLength(2_000);
    expect(view.latest?.errors[0]?.code).toHaveLength(128);
    expect(view.latest?.errors[0]).not.toHaveProperty("line");
    expect(view.status).toEqual({ state: "unknown", at: "x".repeat(64), error: "x".repeat(2_000) });
    expect(view.inventory).toEqual({
      errors: { total: 99_999, shown: 20, truncated: true },
      warnings: { total: 99_999, shown: 0, truncated: true },
    });
  });
});
