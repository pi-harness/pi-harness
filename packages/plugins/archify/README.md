# @pi-harness/plugin-archify

Architecture Map — Build a bounded, read-only architecture map from workspace components and package dependencies.

## Install

```sh
npm install --save-exact @pi-harness/plugin-archify
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: archify
  name: "@pi-harness/plugin-archify"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
