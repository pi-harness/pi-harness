# @pi-harness/plugin-auto-mode

Auto Mode — Execute argv commands under a safe policy that blocks shell wrappers and requires confirmation for risky operations.

## Install

```sh
npm install --save-exact @pi-harness/plugin-auto-mode
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: auto-mode
  name: "@pi-harness/plugin-auto-mode"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native workspace

Risk probes and command execution use the same workspace captured from the active native session. A replacement session, manager, native session ID or workspace invalidates the old result and resets the panel counters. A change during an asynchronous risk probe prevents command execution; a change after process launch discards its result but cannot undo completed side effects. Before the native runtime is available, commands use the launch workspace.
