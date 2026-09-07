# @pi-harness/plugin-plugin-radar

Plugin Radar — Inspect installed and configured plugins with lifecycle state and source metadata.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-radar
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-radar
  name: "@pi-harness/plugin-plugin-radar"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
