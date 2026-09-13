# @pi-harness/plugin-session-bridge

Session Bridge — Preview and export handoffs, then require confirmed import of a strictly validated, bounded package into the active LLM context with duplicate protection.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-bridge
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-bridge
  name: "@pi-harness/plugin-session-bridge"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Delivery and limits

With an active runtime, import uses the native `AgentSession.sendCustomMessage` API so the live agent and journal receive the same handoff. Idle imports return `delivery: "appended"`. During a running turn they return `delivery: "queued"`: the SDK appends them after that turn finishes, making them available to a subsequent model turn. The tool does not start an extra model turn. Queue acceptance is not a persistence acknowledgement. Without a runtime, import appends directly to the native journal for the next session load.

Duplicate protection covers the most recent 10,000 journal entries and up to 100 pending handoffs in the current plugin instance. Exact normalized packages, including their timestamps, define duplicate identity; exporting again creates a new package. Queue reservations are temporary and disappear on plugin reload. A session change before import execution is rejected. Synchronous persistence failures block further bridge reads and writes until the session is reloaded from disk; use the runtime session reload so both agent state and journal are refreshed. The plugin cannot roll back SDK memory changes, repair partial journal writes, or acknowledge later queued-write failures when the SDK flushes them outside the tool call.

Exports are bounded snapshots, not complete archives: at most 100 messages, 16,000 characters per message, 64,000 total text characters and 256 KiB serialized JSON. Images are represented by unresolved markers, not transferred. The five-part preview is a text heuristic, not a model-generated summary; its content is returned in the model-visible tool response.

Missing goal, assistant progress or next-step text is represented by an empty string, not generated instructions. The web panel supplies its localized empty-state label; actual session text is not translated or replaced.

Export, preview and import bind to the native session before parameter inspection and deferred execution. Session replacement clears operation receipts, preview receipts and status. Import rechecks the target before writing and after delivery; stale completions cannot update the replacement session. An already appended or queued handoff cannot be rolled back after a session change. Write-failure quarantine remains attached to the original session header.

Once the native send operation resolves, the handoff is considered committed (or queued by the SDK). Cancellation that arrives during or immediately after that persistence window does not turn the receipt into a misleading cancellation; the tool returns the successful delivery receipt. Cancellation before the send resolves still aborts the operation, and any uncertain partial write remains subject to the reload guidance above.
