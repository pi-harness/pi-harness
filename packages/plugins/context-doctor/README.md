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
