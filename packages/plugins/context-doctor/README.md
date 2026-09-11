# @pi-harness/plugin-context-doctor

Context Doctor — Descriptor-safe bounded context audits detect pressure, oversized or uninspectable messages, and tool errors. Compaction requests are queued until the agent has settled; confirmed model-backed compaction may incur cost and provides cancellable waits with dedicated cancellation.

## Install

```sh
npm install --save-exact @pi-harness/plugin-context-doctor
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: context-doctor
  name: "@pi-harness/plugin-context-doctor"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Audit and compaction boundaries

The audit is descriptor-safe and bounded; it reports current context pressure, oversized or uninspectable messages, and tool errors without invoking message accessors. `context_doctor` compacts only with both `compact=true` and `confirm=true`, waits for an active agent run to settle, and uses the SDK's dedicated compaction cancellation without aborting the agent turn.

Context Doctor shares a per-native-session compaction slot with History Compressor and Session Insights. A request made while any of them owns that slot fails explicitly instead of overlapping `AgentSession.compact()` calls and overwriting the SDK's cancellation controller. Caller cancellation can stop waiting promptly while the slot remains held until the native Promise settles; if the SDK publishes a late `compaction_start` controller after cancellation, Context Doctor aborts that controller again. If a provider later succeeds, the panel records that native completion rather than falsely labeling it cancelled.
