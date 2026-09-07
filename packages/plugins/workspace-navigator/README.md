# @pi-harness/plugin-workspace-navigator

Workspace Navigator — Show a bounded workspace tree and read-only Git status for a high-signal coding sidebar.

## Install

```sh
npm install --save-exact @pi-harness/plugin-workspace-navigator
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: workspace-navigator
  name: "@pi-harness/plugin-workspace-navigator"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
