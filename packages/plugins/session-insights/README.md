# @pi-harness/plugin-session-insights

Session Insights — Publish descriptor-safe validated cached session statistics and run only confirmed settled-session compaction with explicit model usage and cost guidance plus cancellable lifecycle handling.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-insights
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-insights
  name: "@pi-harness/plugin-session-insights"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Statistics and compaction

Statistics come from the active SDK session. Message counts and tracked token/cost totals cover the entire native journal, including historical branches; usage recorded on compaction and branch-summary entries is included. They do not describe only the current active context. `contextUsage` describes the current branch, and its token count may be unknown immediately after compaction until a subsequent assistant response. Cost is SDK-reported usage, not a provider invoice. The model-visible report includes all statistics and this scope.

The panel refreshes on relevant session events and runtime/session-ID changes; per-token deltas do not trigger a full journal scan. Confirmed compaction waits for an active run to settle and uses the native model-backed SDK path. A changed runtime object or session ID cancels queued work and detected in-flight work. Dedicated compaction cancellation is used for caller abort or plugin disposal. Model-backed compaction can make multiple requests and adds usage to the cumulative totals even as it reduces the live context.

Cancellation also covers the SDK initialization interval before its compaction controller exists: a native compaction-start listener re-applies cancellation. The listener and single-flight lock remain until the underlying SDK compaction promise settles, even if the tool caller has already received cancellation. The lock is shared per native session with History Compressor and Context Doctor, so concurrent plugin requests fail explicitly instead of overwriting the SDK's compaction controller.
