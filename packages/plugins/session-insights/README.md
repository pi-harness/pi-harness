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
