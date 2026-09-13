# @pi-harness/plugin-tab-manager

Session Tabs — Organize active Pi sessions into named tabs and switch between them without losing session identity.

## Install

```sh
npm install --save-exact @pi-harness/plugin-tab-manager
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: tab-manager
  name: "@pi-harness/plugin-tab-manager"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Session activation

`session_tab_manage` supports `pin`, `unpin`, `rename`, `remove`, `list` and `activate`. Paths must be absolute and are normalized before storage. Labels contain 1–120 UTF-16 units. With no explicit path, the active runtime's native session manager supplies the target; in-memory sessions without a persistent path cannot be pinned implicitly. Removing a tab never deletes its session file.

`activate` requires the running Pi runtime. It returns a request ID with `state: "waiting"` immediately, then waits for the entire current turn to become idle before invoking the native `AgentSessionRuntime.switchSession`. Only one activation may be pending. The panel and `list` expose `waiting`, `switching`, `completed`, `cancelled` or `failed`, plus a bounded error when available. A queued request is not a completed switch.

Before switching, the plugin rechecks the source runtime/session, requires the tab still exist, and reads at most 4 MiB from a regular native version-3 session file. A missing or invalid target fails without asking the SDK to create it. Cancellation and disposal stop queued work; once the native switch has begun, the operation cannot be rolled back by cancelling the original tool. Native runtime creation failures are surfaced and may require the host to recreate its runtime.

The store uses `selectedId` for the selected metadata row. `currentSessionPath` comes from the actual runtime and determines the current-session badge. There is no legacy `activeId` alias or migration. The 24-tab, 1 MiB store is serialized under a process-aware lock and atomically replaced with mode 0600. The lock times out after 10 seconds; stale dead-owner locks can be reclaimed after 30 seconds. Explicit non-current paths use the file basename as their tab ID, so duplicate basenames in different directories are rejected.

Activation status is in memory and is not resumed after restart. Session files may change between validation and native opening; this is not a filesystem transaction. The panel shows stored tabs and actual activation status; model tools perform the management actions.
