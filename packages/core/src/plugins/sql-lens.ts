import { DatabaseSync } from "node:sqlite";
import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type SqlReport = { database: string; query: string; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean };

function databasePath(workspace: string, requested: string): { absolute: string; relative: string } {
  const root = resolve(workspace);
  const absolute = resolve(root, requested);
  const path = relative(root, absolute);
  if (path.startsWith("..") || path.includes("/..")) throw new Error("Database path must stay inside the current workspace");
  return { absolute, relative: path || "." };
}

function assertReadOnlyQuery(query: string): string {
  const normalized = query.trim().replace(/;+$/g, "");
  if (!/^(select|pragma|with)\b/i.test(normalized)) throw new Error("SQL Lens only allows SELECT, WITH, and PRAGMA queries");
  if (/^pragma\b/i.test(normalized)) {
    if (
      !/^pragma\s+(table_info|table_xinfo|index_list|index_info|foreign_key_list|database_list|user_version|schema_version|compile_options|encoding|page_count|page_size|freelist_count|application_id|auto_vacuum)\b/i.test(
        normalized,
      )
    )
      throw new Error("SQL Lens rejected a non-read-only PRAGMA");
  }
  if (/[;=]|\b(insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex|replace)\b/i.test(normalized))
    throw new Error("SQL Lens rejected a mutating or multi-statement query");
  return normalized;
}

export default {
  name: "pi-sql-lens",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: SqlReport | undefined;
    const run = async (database = "data.db", query = "SELECT name, type FROM sqlite_master ORDER BY type, name"): Promise<SqlReport> => {
      const workspace = await realpath(context.piHarnessLaunch.cwd);
      const requested = databasePath(workspace, database);
      const canonical = databasePath(workspace, await realpath(requested.absolute));
      const location = canonical;
      const metadata = await stat(location.absolute);
      if (!metadata.isFile()) throw new Error("Database path is not a file");
      const safeQuery = assertReadOnlyQuery(query);
      const db = new DatabaseSync(location.absolute, { readOnly: true });
      try {
        const rows = db.prepare(safeQuery).all() as Record<string, unknown>[];
        const limited = rows.slice(0, 100);
        latest = {
          database: location.relative,
          query: safeQuery,
          columns: limited.length ? Object.keys(limited[0] ?? {}) : [],
          rows: limited,
          truncated: rows.length > limited.length,
        };
        return latest;
      } finally {
        db.close();
      }
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "sql_readonly",
        label: "SQL read-only",
        description: "Inspect a SQLite database with a bounded read-only SELECT, WITH, or PRAGMA query.",
        promptSnippet: "inspect a local SQLite database without writes",
        parameters: Type.Object({
          database: Type.Optional(Type.String({ description: "SQLite path relative to workspace" })),
          query: Type.Optional(Type.String({ description: "Read-only SELECT, WITH, or PRAGMA query" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<SqlReport>> {
          const report = await run(params.database, params.query);
          return { content: [{ type: "text", text: `${report.database}: ${report.rows.length} row(s).` }], details: report };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "sql-lens-panel",
      pluginId: "@pi-harness/core/plugins/sql-lens",
      title: "SQL Lens",
      description: "以只读模式浏览 SQLite 数据库 Schema 和查询结果。",
      icon: "⌗",
      read: () => ({ latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
