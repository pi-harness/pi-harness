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

Availability, version, errors, and the latest run reset when the native session or workspace changes. A pending call rejects after a session change instead of returning or caching its old result. A command already started can still finish and affect the configured virtual workspace; switching sessions does not undo that command. Caller cancellation, plugin disposal, timeout and output-limit failures terminate the host CLI's POSIX process group, escalating after one second even if the parent exits first. Windows uses taskkill tree termination with direct-process fallback (native Windows verification outstanding). After escalation, inherited output pipes cannot hold the failed call open. Deliberately escaped local descendants are not contained. Stopping the local CLI does not prove cancellation of a job already submitted to the remote virtual workspace.

A terminated command is not successful even if its signal handler exits with code zero. Timeout and output-limit diagnostics remain visible in the tool result and panel; output-limit termination explicitly marks the result incomplete. A timed-out version probe does not establish CLI availability.

Combined stdout/stderr retained in `lastRun.output` is bounded to 128 KiB of UTF-8, including an explicit notice when only the tail fits. Truncation preserves complete Unicode code points and the final failure diagnostic. Each individual stream also has a 128 KiB process-output limit.
