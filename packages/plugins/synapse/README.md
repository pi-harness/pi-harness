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

`synapse_session_map` accepts an empty object and returns the complete displayed graph as JSON, including nodes, fork edges, the workspace, total inventory count and truncation status. The active runtime session manager determines the workspace and session directory. Before runtime initialization the native `piSession` manager supplies this context. No legacy report aliases are supported.

Panel polls reuse a detached snapshot for up to five seconds within the same session context. Explicit tool calls rescan. Session switches, plugin disposal and caller cancellation reject obsolete scans; the SDK listing itself cannot be interrupted, so cancellation is reported once it settles. This is a read-only map, not a session switcher or work-item editor.

`maxSessions` must be an integer from 1 to 2000 (default 500). It limits returned nodes after the native SDK has read and sorted the complete directory; it does not bound disk I/O, memory use or scan duration. Node labels are limited to 120 UTF-16 units without splitting surrogate pairs. Only persisted sessions appear, and a parent outside the returned subset is counted as undisplayed, not proven missing. Fork edges describe separate native session files, not branches within one journal.

Before listing, Synapse opens and closes the session directory to surface access errors or a path that is not a directory, instead of treating those failures as a successful empty map. A missing directory remains a normal empty inventory before the first persisted session. This preflight is not an atomic guarantee: subsequent filesystem changes and individual journal reads retain the native SDK's behavior.

The panel shows at most eight nodes and five edges. Each node's branch count covers the displayed graph only. Files can change during enumeration, so the map is not an atomic filesystem snapshot.
