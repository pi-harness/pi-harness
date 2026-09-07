# @pi-harness/plugin-plugin-stars

Plugin Stars — Search a curated raw.githubusercontent.com plugin snapshot through descriptor-safe inputs, strict bounded validation, a cancellable lifecycle, and fail-closed panel reporting.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-stars
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-stars
  name: "@pi-harness/plugin-plugin-stars"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
