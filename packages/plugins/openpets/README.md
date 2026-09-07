# @pi-harness/plugin-openpets

OpenPets — Keep a bounded durable companion state from validated recent session entries without retaining message contents, with descriptor-safe actions and explicit persistence health.

## Install

```sh
npm install --save-exact @pi-harness/plugin-openpets
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: openpets
  name: "@pi-harness/plugin-openpets"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
