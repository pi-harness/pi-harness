# @pi-harness/plugin-memory

Memory — Persist bounded cross-session notes with explicit recall and update operations.

## Install

```sh
npm install --save-exact @pi-harness/plugin-memory
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: memory
  name: "@pi-harness/plugin-memory"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
