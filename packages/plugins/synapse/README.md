# @pi-harness/plugin-synapse

Synapse displays persisted Pi sessions and native fork relationships without changing the transcript.

## Install

```sh
npm install --save-exact @pi-harness/plugin-synapse
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: synapse
  name: "@pi-harness/plugin-synapse"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Behavior and limits

`synapse_session_map` accepts an empty object and returns the complete displayed graph as JSON, including nodes, fork edges, the workspace, total inventory count, result truncation, metadata truncation and unavailable-metadata counts. The active runtime session manager determines the workspace and session directory. Before runtime initialization the native `piSession` manager supplies this context. No legacy report aliases are supported.

Panel polls reuse a detached snapshot for up to five seconds within the same session context. Explicit tool calls rescan. Session switches, plugin disposal and caller cancellation reject obsolete scans during directory discovery and file reads. This is a read-only map, not a session switcher or work-item editor.

`maxSessions` must be an integer from 1 to 2000 (default 500). Synapse enumerates every JSONL filename so `total` remains accurate, but reads at most 64 KiB for each journal header and retains only the newest `maxSessions` candidates in memory by filesystem modification time. The active persisted session reserves a place even when newer journals fill the limit. Selected journals are read in batches of eight with a 4 MiB per-file limit. Larger selected journals remain visible as header-only nodes with `messagesTruncated: true`; files that change identity, become malformed or cannot be read after discovery are omitted and counted in `metadataUnavailable`.

Node labels are limited to 120 UTF-16 units without splitting surrogate pairs. Only persisted sessions appear, and a parent outside the returned subset is counted as undisplayed, not proven missing. Fork edges describe separate native session files, not branches within one journal.

Directory access errors and paths that are not directories are surfaced instead of being treated as a successful empty map. A missing directory remains a normal empty inventory before the first persisted session. Custom shared directories require a non-empty journal `cwd` matching the active workspace; default per-workspace directories preserve legacy empty or stale stored `cwd` values for compatibility with Pi's native listing. Files are opened without following symbolic links and must remain regular files. Files can still change between bounded header discovery and selected metadata reads, so the map is not an atomic filesystem snapshot.

The panel shows at most eight nodes and five edges. Each node's branch count covers the displayed graph only. Files can change during enumeration, so the map is not an atomic filesystem snapshot.
