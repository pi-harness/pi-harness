# @pi-harness/plugin-context

Context Insights — Inspect context usage and descriptor-safe bounded message composition with cached active-session lifecycle counters and a fixed-limit normalized browser panel.

Cached composition and lifecycle counters are scoped to both the active runtime session object and its session ID. Browser snapshots carry that ID so delayed responses from a previous session are rejected instead of rendering stale context metrics.

## Install

```sh
npm install --save-exact @pi-harness/plugin-context
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: context
  name: "@pi-harness/plugin-context"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
