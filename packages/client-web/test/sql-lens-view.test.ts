import { describe, expect, test } from "vitest";
import { sqlLensPanelView, sqlLensRowsJson } from "../src/sql-lens-view.js";

describe("SQL Lens panel view", () => {
  test("renders arbitrary SQL TEXT as reversible JSON without active format controls", () => {
    const rows = [{ note: "A\u0000\u007f\u0085\u200d\u202e\u2028\u2029😀\n\t\\u202e" }];
    const text = sqlLensRowsJson(rows);
    expect(JSON.parse(text)).toEqual(rows);
    expect(text).not.toMatch(/[\u007f-\u009f\p{Cf}\u2028\u2029]/u);
    expect(text).toContain("\\u202e");
    expect(text).toContain("😀");
    expect(text).toContain("\n");
  });

  test.each([
    ["x".repeat(16_384), false, false],
    ["x".repeat(16_384) + "…", true, false],
    ["x".repeat(16_384) + "…", false, true],
    ["x".repeat(16_385), true, true],
    ["x".repeat(16_385) + "…", true, true],
  ])("validates bounded TEXT and its optional truncation suffix (%#)", (content, truncated, malformed) => {
    const view = sqlLensPanelView({
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
      timeoutMs: 5_000,
      latest: {
        cwd: "/workspace",
        database: "data.db",
        query: "SELECT content FROM users",
        columns: ["content"],
        rows: [{ content }],
        truncated,
        scannedRows: 1,
        rowInventory: { scanned: 1, returned: 1, shown: 1, truncated, displayLimit: 20 },
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
    expect(view.malformed).toBe(malformed);
    if (!malformed) expect(view.latest?.rows[0]?.content).toBe(content);
  });

  test("normalizes query results, status, row inventory, and limits", () => {
    const view = sqlLensPanelView({
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
      timeoutMs: 1_500,
      latest: {
        cwd: "/workspace",
        database: "data.db",
        query: "-- multiline query\nSELECT id, name FROM users",
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
        cwd: "/workspace",
        database: "data.db",
        query: "-- multiline query\nSELECT id, name FROM users",
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

  test("keeps a result set larger than the panel row cap", () => {
    const view = sqlLensPanelView({
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
      timeoutMs: 5_000,
      latest: {
        cwd: "/workspace",
        database: "data.db",
        query: "SELECT id, name FROM users LIMIT 50",
        columns: ["id", "name"],
        rows: Array.from({ length: 20 }, (_, index) => ({ id: index + 1, name: `user-${index + 1}` })),
        truncated: false,
        scannedRows: 50,
        rowInventory: { scanned: 50, returned: 50, shown: 20, truncated: true, displayLimit: 20 },
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

    expect(view.malformed).toBe(false);
    expect(view.latest?.rows).toHaveLength(12);
    expect(view.latest?.rows[0]).toEqual({ id: 1, name: "user-1" });
    expect(view.latest?.rowInventory).toEqual({ scanned: 50, returned: 50, shown: 12, truncated: true, displayLimit: 20 });
  });

  test("fails closed for contradictory payloads without inventing zero-valued results", () => {
    const base = {
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
      timeoutMs: 5_000,
      latest: {
        cwd: "/workspace",
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
        cwd: "/workspace",
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

  test("keeps arbitrary TEXT and column names while database paths stay strict", () => {
    const note = "line one\nline two\ttabbed\r\n";
    const payload = {
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
      timeoutMs: 5_000,
      latest: {
        cwd: "/workspace",
        database: "data.db",
        query: "SELECT id, note FROM notes",
        columns: ["id", "note"],
        rows: [{ id: 1, note }],
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
    };

    expect(sqlLensPanelView(payload)).toMatchObject({ malformed: false, latest: { rows: [{ id: 1, note }] } });
    const chinese = "汉".repeat(16000);
    expect(
      sqlLensPanelView({ ...payload, latest: { ...payload.latest, query: `SELECT '${chinese}' AS note`, rows: [{ id: 1, note: chinese }] } }).malformed,
    ).toBe(false);
    for (const cell of ["text\u0000cell", "text\u2028cell", "text\u{e0001}cell", "lone\ud800"]) {
      const view = sqlLensPanelView({ ...payload, latest: { ...payload.latest, rows: [{ id: 1, note: cell }] } });
      expect(view.malformed).toBe(false);
      expect(view.latest?.rows).toEqual([{ id: 1, note: cell }]);
      const rendered = sqlLensRowsJson(view.latest!.rows);
      expect(JSON.parse(rendered)).toEqual([{ id: 1, note: cell }]);
      expect(rendered).not.toMatch(/[\p{Cf}\p{Cs}\u2028]/u);
    }
    expect(sqlLensPanelView({ ...payload, latest: { ...payload.latest, columns: ["id", "no\nte"], rows: [{ id: 1, "no\nte": note }] } })).toMatchObject({
      malformed: false,
      latest: { columns: ["id", "no\nte"], rows: [{ id: 1, "no\nte": note }] },
    });
    expect(sqlLensPanelView({ ...payload, latest: { ...payload.latest, database: "data\n.db" } }).malformed).toBe(true);
  });

  test("accepts a result set larger than the panel row cap and reports the displayed slice", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, name: `user-${index + 1}` }));
    const payload = {
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
      timeoutMs: 5_000,
      latest: {
        cwd: "/workspace",
        database: "data.db",
        query: "-- multiline query\nSELECT id, name FROM users",
        columns: ["id", "name"],
        rows,
        truncated: false,
        scannedRows: 25,
        rowInventory: { scanned: 25, returned: 25, shown: 20, truncated: true, displayLimit: 20 },
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
    };
    const view = sqlLensPanelView(payload);

    expect(view.malformed).toBe(false);
    expect(view.latest?.rows).toHaveLength(12);
    expect(view.latest?.rowInventory).toEqual({ scanned: 25, returned: 25, shown: 12, truncated: true, displayLimit: 20 });
    expect(sqlLensPanelView({ ...payload, latest: { ...payload.latest, rowInventory: { ...payload.latest.rowInventory, shown: 19 } } }).malformed).toBe(true);
    expect(sqlLensPanelView({ ...payload, latest: { ...payload.latest, rowInventory: { ...payload.latest.rowInventory, returned: 19 } } }).malformed).toBe(
      true,
    );
    expect(sqlLensPanelView({ ...payload, latest: { ...payload.latest, rowInventory: { ...payload.latest.rowInventory, returned: 101 } } }).malformed).toBe(
      true,
    );
    expect(
      sqlLensPanelView({ ...payload, latest: { ...payload.latest, scannedRows: 19, rowInventory: { ...payload.latest.rowInventory, scanned: 19 } } }).malformed,
    ).toBe(true);
  });
});
