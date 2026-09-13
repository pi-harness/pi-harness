# @pi-harness/plugin-history-compressor

History Compressor — Compact the current Pi session automatically when context usage approaches a configured threshold.

## Install

```sh
npm install --save-exact @pi-harness/plugin-history-compressor
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: history-compressor
  name: "@pi-harness/plugin-history-compressor"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Scheduling and cancellation

`thresholdPercent` defaults to 85 and is clamped to 1–100. After an agent run reports usage at or above the threshold, automatic compaction waits for the authoritative `agent_settled` event instead of interrupting the turn. It rechecks current usage at settlement and drops the queued request if another operation already reduced the context. Set `enabled: false` to disable only automatic threshold compaction.

`compress_history` requires exactly `{ "confirm": true }` because native model-backed compaction can make multiple provider requests and incur usage or cost. Unknown, accessor-backed, and otherwise malformed runtime parameters are rejected before compaction. Explicit requests remain unconditional after a busy turn settles. The panel reports the active session ID, latest observed usage, queued state, successful plugin-owned compactions, and a bounded error. These metrics are stored separately for each runtime session and session ID; switching sessions starts with clean panel metrics, while late completion or failure from an old session updates only that old session's state. The web client rejects a retained panel snapshot whose session ID does not match the active session.

Caller cancellation, plugin disposal, and detected session replacement return promptly and use the SDK's dedicated compaction abort. The native Promise keeps the session-level single-flight slot until it actually settles, so a provider that ignores cancellation cannot permit overlapping compactions. History Compressor, Session Insights, and Context Doctor share that per-session slot; a request made while another plugin owns it reports that compaction is already running. A late SDK `compaction_start` event re-applies cancellation when its controller did not exist at the first abort request.
