# @pi-harness/plugin-context

Context Insights — Inspect context usage and descriptor-safe bounded message composition with cached active-session lifecycle counters and a fixed-limit normalized browser panel.

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
