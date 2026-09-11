# @pi-harness/plugin-auto-mode

Auto Mode — Execute argv commands under a safe policy that blocks shell wrappers and requires confirmation for risky operations.

Timeouts are failures even when the terminated command's signal handler exits zero. The result retains a nonzero exit code and timeout diagnostic; output-limit termination is reported separately as incomplete output. Caller cancellation continues to reject rather than publish a completed receipt.

Commands run noninteractively: their unused stdin is closed immediately, so commands that read standard input receive EOF instead of waiting for input the tool cannot supply.

On macOS/Linux, commands start in their own process group. Timeout, cancellation and output-limit termination signal the group, then escalate to SIGKILL after a one-second grace period even if the parent exits first. Windows uses `taskkill /T /F` while the root still exists, with direct-process termination as a fallback if that command fails. After escalation, output pipes are closed and the failed operation settles even if a descendant retains those pipes. Descendants that deliberately detach into another process group are not contained; returning a failure does not prove every descendant exited. This is lifecycle cleanup, not an OS sandbox; native Windows acceptance remains outstanding.

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
