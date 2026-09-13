# @pi-harness/plugin-plugin-dev

Plugin Dev — Defer Pi session resource reloads until the agent is settled, enforce a single active reload with bounded status, and expose the operation only for trusted local development.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-dev
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-dev
  name: "@pi-harness/plugin-plugin-dev"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
