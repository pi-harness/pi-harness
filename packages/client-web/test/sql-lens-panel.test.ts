import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "sql-lens-panel", pluginId: "@pi-harness/plugin-sql-lens", title: "SQL Lens", data },
    }),
  );
}

const valid = {
  status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
  timeoutMs: 5_000,
  latest: {
    cwd: "/workspace",
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
};

describe("SQL Lens panel", () => {
  test("shows Unicode column names and queries without active format controls", () => {
    const column = "note\u200d\u202e\u2028\u007f";
    const html = renderPanel({ ...valid, latest: { ...valid.latest, query: `SELECT 1 AS "${column}"`, columns: [column], rows: [{ [column]: 1 }] } });
    expect(html).toContain("1 rows");
    expect(html).toContain("note\\u200d\\u202e\\u2028\\u007f");
    expect(html).not.toMatch(/[\u007f\p{Cf}\u2028]/u);
    expect(html).not.toContain("SQL Lens 面板数据异常");
  });
  test("renders a validated result and limits", () => {
    const html = renderPanel(valid);
    for (const expected of ["已完成", "/workspace", "data.db", "1 rows", "Ada", "timeout:5000ms", "rows:100", "result:1024KiB"])
      expect(html).toContain(expected);
    expect(html).not.toContain("SQL Lens 面板数据异常");
  });

  test("fails closed for malformed data instead of showing a fake empty result", () => {
    const html = renderPanel({ ...valid, latest: { ...valid.latest, rowInventory: { ...valid.latest.rowInventory, returned: 0 } } });
    expect(html).toContain("SQL Lens 面板数据异常");
    expect(html).toContain("面板数据不完整或不可信");
    expect(html).not.toContain("0 rows");
    expect(html).not.toContain("还没有查询数据库");
  });

  test("renders a result set larger than the panel row cap and multi-line TEXT cells", () => {
    const html = renderPanel({
      ...valid,
      latest: {
        cwd: "/workspace",
        database: "data.db",
        query: "SELECT id, note FROM notes",
        columns: ["id", "note"],
        rows: Array.from({ length: 20 }, (_, index) => ({ id: index + 1, note: `note ${index + 1}\nsecond line` })),
        truncated: false,
        scannedRows: 25,
        rowInventory: { scanned: 25, returned: 25, shown: 20, truncated: true, displayLimit: 20 },
      },
    });
    expect(html).toContain("25 rows");
    expect(html).toContain("second line");
    expect(html).not.toContain("SQL Lens 面板数据异常");
  });
});
