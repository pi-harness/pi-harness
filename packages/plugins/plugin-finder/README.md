# @pi-harness/plugin-plugin-finder

Plugin Finder — Search a configured npm-compatible registry for Pi plugins with bounded queries and explicit installation handoff.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-finder
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-finder
  name: "@pi-harness/plugin-plugin-finder"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
