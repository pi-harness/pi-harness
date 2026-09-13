# @pi-harness/plugin-undo-savepoint

Undo Savepoints — Create inspectable savepoints before agent changes so the workspace can be restored safely.

## Install

```sh
npm install --save-exact @pi-harness/plugin-undo-savepoint
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: undo-savepoint
  name: "@pi-harness/plugin-undo-savepoint"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Operations

`undo_savepoint` supports `save`, `list`, `diff`, and `restore`. `save` accepts an optional reason (up to 4,096 characters); `diff` and `restore` require an exact savepoint ID. `restore` additionally requires `confirm=true`. Unknown actions, extra keys, getters, and fields belonging to another action are rejected before file access. Model-visible text is the same structured JSON report as tool details; file contents are not returned.

Operations use the current native session manager's canonical workspace directory. Before a runtime is available they use the launch workspace. Each manifest requires its workspace, capture-completeness flag, file modes, and SHA-256-verified content; there is no legacy manifest fallback. A manifest belonging to a different canonical workspace cannot be diffed or restored. Listing filters to the current workspace. The store is `<agentDir>/<storeName>` (default `undo-savepoints`), and its directory cannot be a symlink. Manifests are written atomically with owner-only permissions. The store is excluded from snapshots and restoration, including when it lives inside the workspace.

Snapshots are manual, not automatically created before agent edits. They include existing regular files under `trackedPaths` (default `["."]`), skipping symlinks, known credential names, dependency/build directories, and files containing NUL bytes. This heuristic does not detect every secret or binary format. A snapshot contains file bytes and permissions; it is not a Git commit, filesystem-wide snapshot, or undo log for arbitrary tool side effects.

## Restore behavior

Restore read-only preflights every destination before creating directories or replacing file content, then performs a rollback-backed multi-file transaction. Each replacement is first written durably to a unique same-directory stage, existing destinations are moved to unique same-directory rollback files, and stages are published with create-only hard links. Files and empty parent directories that did not exist before the restore are removed during rollback. If a later write, caller cancellation, plugin disposal, or session/workspace check fails before the transaction commits, completed replacements are rolled back in reverse order. If rollback itself encounters an operating-system failure, the tool reports that rollback was incomplete and requires inspecting the workspace before retrying. The transaction is process-level protection, not a filesystem-wide or power-loss-durable transaction, and it does not lock out external writers.

It overwrites the files named by the snapshot and recreates missing files; it does not delete files created later. Ignored directory/store entries are skipped and reported. An invalid path or destination discovered during preflight leaves the workspace unchanged. A rolled-back restore removes only empty directories it needed to create, so an external writer can prevent exact directory cleanup; that condition is reported as an incomplete rollback rather than deleting the writer's content. Stop other workspace writers before restoring. Check the diff and preserve newer changes before confirming an overwrite.

Restored permissions always retain owner read/write and never grant new executable, group-write, or other-write permissions from a manifest. An already executable destination retains its own permissions. The current format requires recorded modes; missing modes are rejected.

Only one tool operation may run at a time. Caller cancellation and plugin disposal reach atomic writes before their commit boundary, and rollback deliberately ignores the already-triggered cancellation so it can restore the captured workspace. Caller-provided Error cancellation reasons retain their identity. Workspace/session identity is rechecked between asynchronous stages, file writes, and the final transaction commit. An in-flight file write remains bound to its captured workspace, so a session switch cannot redirect it to the new workspace. Once every replacement and the final identity check succeed, a later session change does not turn that committed restore into a reported failure. Stage and rollback-file deletion is post-commit cleanup: failures do not reject the completed restore and are returned as exact paths in `cleanupPending` for manual inspection. `diff` compares snapshot content only, does not report added files or permission changes, and classifies unavailable or oversized current files as missing.

## Bounds

Default limits are 400 files and 256 KiB per file, configurable up to 2,000 files and 2 MiB per file. Every snapshot is additionally bounded to 8 MiB of decoded content, 8,192 traversal entries (including ignored entries and symlinks), 512 directories, depth 32, and a 16 MiB manifest. Hitting a capture limit or failing to read an otherwise eligible file sets `truncated=true`; reaching a limit exactly is conservatively marked incomplete. Excluded file categories are outside the snapshot scope and do not by themselves set this flag.

One list request discovers at most 1,000 directory entries, sorts the discovered manifest names, and parses at most 100 candidates. Invalid or foreign-workspace candidates are omitted, so the returned count is a bounded result count, not a total inventory. The panel displays at most six results, identifies the current workspace, and marks incomplete snapshots. Savepoint storage has no automatic retention or pruning.
