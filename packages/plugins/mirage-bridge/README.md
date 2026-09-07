# @pi-harness/plugin-mirage-bridge

Mirage Bridge — Connect Pi Harness to the official Mirage virtual-terminal CLI without adding a second host shell.

## Install

```sh
npm install --save-exact @pi-harness/plugin-mirage-bridge
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: mirage-bridge
  name: "@pi-harness/plugin-mirage-bridge"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
