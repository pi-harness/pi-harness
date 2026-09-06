import { lstatSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

type WorkerInput = {
  database: string;
  query: string;
  device: number | bigint;
  inode: number | bigint;
  limits: { databaseBytes: number; rows: number; columns: number; stringLength: number; resultBytes: number; blobPreviewBytes: number };
};

type BlobCell = { type: "blob"; bytes: number; previewBase64: string; truncated: boolean };
type SqlCell = null | string | number | BlobCell;

const input = workerData as WorkerInput;
const allowedPragmas = new Set([
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "foreign_key_list",
  "database_list",
  "user_version",
  "schema_version",
  "compile_options",
  "encoding",
  "page_count",
  "page_size",
  "freelist_count",
  "application_id",
  "auto_vacuum",
]);

function skipTrivia(sql: string, start = 0): number {
  let index = start;
  while (index < sql.length) {
    if (/\s/u.test(sql[index]!)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      return newline === -1 ? sql.length : skipTrivia(sql, newline + 1);
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) throw new Error("SQL Lens query contains an unterminated block comment");
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function leadingSql(sql: string): string {
  return sql.slice(skipTrivia(sql));
}

function hasUnquotedEquals(sql: string): boolean {
  let quote: "'" | '"' | "`" | "]" | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote !== undefined) {
      if (character !== quote) continue;
      if (quote !== "]" && sql[index + 1] === quote) {
        index += 1;
        continue;
      }
      quote = undefined;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      if (newline === -1) return false;
      index = newline;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "[") quote = "]";
    else if (character === "=") return true;
  }
  return false;
}

function validateStatementKind(sourceSql: string): void {
  const leading = leadingSql(sourceSql);
  const keyword = /^([A-Za-z]+)/u.exec(leading)?.[1]?.toLowerCase();
  if (keyword !== "select" && keyword !== "with" && keyword !== "pragma")
    throw new Error("SQL Lens only allows result-producing SELECT, WITH, and read-only PRAGMA queries");
  if (keyword !== "pragma") return;
  const match = /^pragma\s+(?:(?:main|temp)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)/iu.exec(leading);
  const pragma = match?.[1]?.toLowerCase();
  if (pragma === undefined || !allowedPragmas.has(pragma) || hasUnquotedEquals(leading)) throw new Error("SQL Lens rejected a non-read-only PRAGMA");
}

function metadataMatches(): boolean {
  const metadata = lstatSync(input.database);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== input.device || metadata.ino !== input.inode) return false;
  let totalBytes = metadata.size;
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      const sidecar = lstatSync(input.database + suffix);
      if (!sidecar.isFile() || sidecar.isSymbolicLink()) return false;
      totalBytes += sidecar.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return totalBytes <= input.limits.databaseBytes;
}

function normalizeCell(value: SQLOutputValue): { value: SqlCell; truncated: boolean } {
  if (typeof value === "bigint") {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return { value: Number(value), truncated: false };
    return { value: value.toString(), truncated: false };
  }
  if (typeof value === "string") {
    if (value.length <= input.limits.stringLength) return { value, truncated: false };
    return { value: value.slice(0, input.limits.stringLength) + "…", truncated: true };
  }
  if (value instanceof Uint8Array) {
    const preview = value.subarray(0, input.limits.blobPreviewBytes);
    return {
      value: {
        type: "blob",
        bytes: value.byteLength,
        previewBase64: Buffer.from(preview).toString("base64"),
        truncated: value.byteLength > preview.byteLength,
      },
      truncated: value.byteLength > preview.byteLength,
    };
  }
  return { value, truncated: false };
}

function run() {
  if (!metadataMatches()) throw new Error("Database file changed before the SQL Lens query started");
  const database = new DatabaseSync(input.database, {
    readOnly: true,
    allowExtension: false,
    timeout: 1_000,
    readBigInts: true,
    returnArrays: true,
  });
  try {
    const statement = database.prepare(input.query);
    const remainder = input.query.slice(statement.sourceSQL.length);
    if (skipTrivia(remainder) !== remainder.length) throw new Error("SQL Lens requires a single SQL statement");
    validateStatementKind(statement.sourceSQL);
    const columns = statement.columns().map((column) => column.name);
    if (columns.length === 0) throw new Error("SQL Lens requires a read-only result-producing query");
    if (columns.length > input.limits.columns) throw new Error(`SQL Lens query exceeds the ${input.limits.columns}-column limit`);
    if (new Set(columns).size !== columns.length) throw new Error("SQL Lens query must return uniquely named columns");
    if (columns.some((column) => column.length === 0 || column.length > 512)) throw new Error("SQL Lens column names must contain 1-512 characters");

    const rows: Record<string, SqlCell>[] = [];
    let scannedRows = 0;
    let resultBytes = 0;
    let truncated = false;
    const iterator = statement.iterate() as Iterable<readonly SQLOutputValue[]>;
    for (const rawRow of iterator) {
      scannedRows += 1;
      if (rows.length >= input.limits.rows) {
        truncated = true;
        break;
      }
      const row: Record<string, SqlCell> = Object.create(null) as Record<string, SqlCell>;
      let rowTruncated = false;
      for (let index = 0; index < columns.length; index += 1) {
        const normalized = normalizeCell(rawRow[index] ?? null);
        row[columns[index]!] = normalized.value;
        rowTruncated ||= normalized.truncated;
      }
      const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
      if (resultBytes + rowBytes > input.limits.resultBytes) {
        truncated = true;
        break;
      }
      resultBytes += rowBytes;
      truncated ||= rowTruncated;
      rows.push(row);
    }
    if (!metadataMatches()) throw new Error("Database file changed while the SQL Lens query was running");
    return { columns, rows, truncated, scannedRows };
  } finally {
    database.close();
  }
}

try {
  parentPort?.postMessage({ ok: true, report: run() });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message.slice(0, 2_000) : "SQL Lens worker failed" });
}
