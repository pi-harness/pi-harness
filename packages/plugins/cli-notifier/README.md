# @pi-harness/plugin-cli-notifier

CLI Notifier — Send local desktop notifications when an agent turn completes, fails, or is aborted, and when context compaction fails.

Success means the platform notification command completed, not a display or read receipt. System notification settings may suppress presentation. The compatibility field `delivered` records command submission only; the UI and tool text explicitly distinguish this from verified delivery. Failed submissions retain a diagnostic reason.

Timeout is failure even if a terminated notification command exits zero. On macOS/Linux, timeout, cancellation and output overflow terminate the local command's process group, escalating after one second; the notification queue can then continue. Cancelled calls do not add success records. Windows uses taskkill tree termination (native Windows acceptance outstanding). Escaped process groups are outside containment, and terminating a local process does not retract a notification the OS may already have received. Windows message/title remain child environment data, never interpolated PowerShell source.

## Install

```sh
npm install --save-exact @pi-harness/plugin-cli-notifier
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: cli-notifier
  name: "@pi-harness/plugin-cli-notifier"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

Cancelling a queued notification rejects its caller immediately without waiting for an earlier system command. The cancelled item is skipped when the queue reaches it; later notifications still wait for the active command. Cancellation removes no notification already submitted to the OS.
