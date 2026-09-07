# @pi-harness/plugin-annotation

Annotations — Capture bounded selections and notes from the conversation for later agent context.

## Install

```sh
npm install --save-exact @pi-harness/plugin-annotation
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: annotation
  name: "@pi-harness/plugin-annotation"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
