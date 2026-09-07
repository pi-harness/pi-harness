# @pi-harness/plugin-synapse

Synapse — Visualize session relationships and linked work items without changing the transcript.

## Install

```sh
npm install --save-exact @pi-harness/plugin-synapse
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: synapse
  name: "@pi-harness/plugin-synapse"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
