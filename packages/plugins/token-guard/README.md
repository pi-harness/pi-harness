# @pi-harness/plugin-token-guard

Token Guard — Use descriptor-safe monitoring to issue at most one abort request per run when a context percentage or billed run-token budget is reached, with bounded errors and a cached normalized panel.

## Install

```sh
npm install --save-exact @pi-harness/plugin-token-guard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: token-guard
  name: "@pi-harness/plugin-token-guard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
