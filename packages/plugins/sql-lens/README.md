# @pi-harness/plugin-sql-lens

SQL Lens — Inspect workspace-contained SQLite databases with strict descriptor-safe inputs, a single read-only statement, bounded results, symlink and replacement checks, timed worker execution, cancellation, and fail-closed panel reporting.

## Install

```sh
npm install --save-exact @pi-harness/plugin-sql-lens
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: sql-lens
  name: "@pi-harness/plugin-sql-lens"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Query behavior and limits

`sql_readonly({ database?: string, query?: string })` defaults to `data.db` and a schema inventory query. It resolves the database inside the active session manager's workspace, or the launch workspace before a runtime session exists. Changing the active session or workspace during an operation rejects the result. The report includes its workspace and complete bounded rows in model-visible JSON; the panel retains the last successful result after a failure.

Only one result-producing SELECT, WITH or allowlisted read-only PRAGMA is accepted. SQLite opens with readOnly enabled and extension loading disabled in a separate child process. Cancellation and timeout kill and reap that process. This does not provide a transaction snapshot across separate calls; SQLite may maintain WAL shared-memory/locking sidecars. For byte-for-byte archival comparisons, use a stable database copy.

Limits: 256 MiB for the database and sidecars, 65,536 query characters, 100 rows, 128 unique columns, 16,384 string characters, 256-byte BLOB previews and a 1 MiB serialized row budget. Text limits use JavaScript UTF-16 code units; truncated previews preserve complete Unicode scalar values. Integers outside JavaScript's safe range are returned as decimal strings; non-finite REAL values are strings. BLOBs include their full byte count and a bounded base64 preview. `scannedRows` counts iterator rows inspected before stopping, often one beyond the returned rows; it is not the full matching count. `truncated` can also indicate shortened cells.

Panel data carries at most 20 rows; the UI shows 12 rows and up to 32 column names, including columns for empty results. Multiline SQL is supported. Query results are data, not instructions. No writes, model calls or external services are required by the plugin, and no legacy result aliases are retained.

TEXT cell previews may contain control or format characters. The panel preserves their values and displays them using reversible JSON escapes, rather than rejecting the result. A truncated cell may include an additional ellipsis after its bounded preview.
