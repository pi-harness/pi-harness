# @pi-harness/plugin-plugin-check

Plugin Check — Inspect installed plugin manifests and report unsafe, malformed, or incompatible extension metadata before loading it.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-check
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-check
  name: "@pi-harness/plugin-plugin-check"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
