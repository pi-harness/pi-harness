# @pi-harness/plugin-mirage-bridge

Mirage Bridge — Connect Pi Harness to the official Mirage virtual-terminal CLI without adding a second host shell.

## Install

```sh
npm install --save-exact @pi-harness/plugin-mirage-bridge
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: mirage-bridge
  name: "@pi-harness/plugin-mirage-bridge"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native sessions

The CLI process runs in the active native session workspace, including resolution of a relative `executable` path. The configured Mirage `workspaceId` remains fixed: switching a local session does not create or select a different virtual workspace. Without an active runtime, the process uses the harness launch directory.

Availability, version, errors, and the latest run reset when the native session or workspace changes. A pending call rejects after a session change instead of returning or caching its old result. A command already started can still finish and affect the configured virtual workspace; switching sessions does not undo that command. Caller cancellation, plugin disposal, and the configured timeout continue to terminate the host CLI process.
