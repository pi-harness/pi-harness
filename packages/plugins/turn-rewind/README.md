# @pi-harness/plugin-turn-rewind

Turn Rewind — Scans a bounded current branch for user turns, supports queued serialized cancellable rewinds after the agent settles, and navigates the native session tree while preserving abandoned branches.

## Install

```sh
npm install --save-exact @pi-harness/plugin-turn-rewind
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: turn-rewind
  name: "@pi-harness/plugin-turn-rewind"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.


## Behavior and limits

`session_rewind` accepts either `turns` (1–20, default 1) or an exact `entryId` from the current candidate list. It scans at most 4,096 current-branch entries and retains the newest 50 text-bearing user turns. Text previews are limited to 500 characters; image-only messages are not candidates. The panel displays the newest eight candidates and reports truncation.

The tool calls the current native `AgentSession.navigateTree`. Selecting a user message normally moves the active leaf to its parent and returns that user's text as `editorText`, bounded to 4,096 characters in the result. The plugin exposes this text but does not populate the Control Room composer or send it again. The abandoned branch remains in the same session journal; this operation does not undo filesystem or tool side effects. Native navigation to the current leaf is a no-op, and the selected branch becomes durable when subsequent native entries are written.

Requests during an active run return `status: "queued"` immediately, then navigate after an `agent_settled` event only if the native session is still idle. Changing the runtime session object, session ID, or session manager cancels the queued request. Only one queued or running rewind is allowed. Candidate caches refresh on settlement, navigation, or session identity changes. Both model-visible text and tool details contain the complete bounded operation result.

`summarize` defaults to false. Setting it to true asks Pi to summarize the abandoned branch and may invoke the configured model and incur cost; it requires a model. Cancellation before navigation starts removes the queued request. Once native navigation starts, aborting the caller or disposing the plugin only stops waiting: it does not cancel or roll back the native navigation. Avoid switching sessions during an active navigation or summary; the native operation owns that transition. The panel distinguishes queued, running, completed, cancelled, and failed outcomes.
