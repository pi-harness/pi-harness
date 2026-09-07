# @pi-harness/plugin-workspace-search

Workspace Search — Search bounded text files in the active workspace with ignored directories and binary content excluded.

## Install

```sh
npm install --save-exact @pi-harness/plugin-workspace-search
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: workspace-search
  name: "@pi-harness/plugin-workspace-search"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
