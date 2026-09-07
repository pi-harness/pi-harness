# @pi-harness/plugin-tab-manager

Session Tabs — Organize active Pi sessions into named tabs and switch between them without losing session identity.

## Install

```sh
npm install --save-exact @pi-harness/plugin-tab-manager
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: tab-manager
  name: "@pi-harness/plugin-tab-manager"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
