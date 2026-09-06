import { describe, expect, test } from "vitest";
import { sqlLensPanelView } from "../src/sql-lens-view.js";

describe("SQL Lens panel view", () => {
  test("normalizes query results, status, row inventory, and limits", () => {
    const view = sqlLensPanelView({
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
      timeoutMs: 1_500,
      latest: {
        database: "data.db",
        query: "SELECT id, name FROM users",
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Ada" }],
        truncated: false,
        scannedRows: 1,
        rowInventory: { scanned: 1, returned: 1, shown: 1, truncated: false, displayLimit: 20 },
      },
      limits: {
        queryLength: 65_536,
        databaseBytes: 268_435_456,
        rows: 100,
        columns: 128,
        stringLength: 16_384,
        resultBytes: 1_048_576,
        blobPreviewBytes: 256,
        panelRows: 20,
      },
    });

    expect(view).toMatchObject({
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z", error: null },
      timeoutMs: 1_500,
      latest: {
        database: "data.db",
        query: "SELECT id, name FROM users",
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Ada" }],
        rowInventory: { scanned: 1, returned: 1, shown: 1, truncated: false, displayLimit: 20 },
      },
      limits: {
        queryLength: 65_536,
        databaseBytes: 268_435_456,
        rows: 100,
        columns: 128,
        stringLength: 16_384,
        resultBytes: 1_048_576,
        blobPreviewBytes: 256,
        panelRows: 20,
      },
    });
  });

  test("fails closed for contradictory payloads without inventing zero-valued results", () => {
    const base = {
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
      timeoutMs: 5_000,
      latest: {
        database: "data.db",
        query: "SELECT id FROM users",
        columns: ["id"],
        rows: [{ id: 1 }],
        truncated: false,
        scannedRows: 1,
        rowInventory: { scanned: 1, returned: 1, shown: 1, truncated: false, displayLimit: 20 },
      },
      limits: { queryLength: 65_536, databaseBytes: 268_435_456, rows: 100, columns: 128, stringLength: 16_384, resultBytes: 1_048_576, panelRows: 20 },
    };
    const malformed = [
      null,
      { ...base, unexpected: true },
      { ...base, latest: { ...base.latest, columns: ["id", "id"] } },
      { ...base, latest: { ...base.latest, rows: [{ id: 1, extra: 2 }] } },
      { ...base, latest: { ...base.latest, rowInventory: { ...base.latest.rowInventory, returned: 0 } } },
      { ...base, latest: { ...base.latest, scannedRows: 0 } },
      { ...base, status: { state: "completed", at: "invalid" } },
      { ...base, limits: { ...base.limits, rows: 99 } },
    ];
    for (const value of malformed) {
      expect(sqlLensPanelView(value)).toMatchObject({ malformed: true, latest: null, status: { state: "unknown" } });
    }
  });

  test("does not invoke accessors or revoked proxies", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { state: "idle" };
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [accessor, revoked.proxy]) {
      expect(() => sqlLensPanelView(value)).not.toThrow();
      expect(sqlLensPanelView(value).malformed).toBe(true);
    }
    expect(getterCalls).toBe(0);
  });

  test("fails closed for oversized or inconsistent untrusted rows and errors", () => {
    const columns = Array.from({ length: 40 }, (_, index) => `column-${index}-${"c".repeat(400)}`);
    const rows = Array.from({ length: 20 }, (_, index) => ({
      [columns[0]!]: "x".repeat(5_000),
      [columns[1]!]: { type: "blob", bytes: 70_000, previewBase64: "YQ==", truncated: true },
      [columns[2]!]: Number.NaN,
      [`unknown-${index}`]: "ignored",
    }));
    const view = sqlLensPanelView({
      status: { state: "failed", at: "2026-09-05T01:00:00.000Z", error: "e".repeat(5_000) },
      timeoutMs: Number.NaN,
      latest: {
        database: "d".repeat(8_000),
        query: "q".repeat(80_000),
        columns,
        rows,
        scannedRows: -1,
        rowInventory: {},
      },
      limits: {
        queryLength: 65_536,
        databaseBytes: 268_435_456,
        rows: 100,
        columns: 128,
        stringLength: 16_384,
        resultBytes: 1_048_576,
        blobPreviewBytes: 256,
        panelRows: 20,
      },
    });

    expect(view).toMatchObject({ malformed: true, latest: null, status: { state: "unknown", at: null, error: null }, timeoutMs: 5_000 });
  });
});
