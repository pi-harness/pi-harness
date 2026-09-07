# @pi-harness/plugin-auto-mode

Auto Mode — Execute argv commands under a safe policy that blocks shell wrappers and requires confirmation for risky operations.

## Install

```sh
npm install --save-exact @pi-harness/plugin-auto-mode
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: auto-mode
  name: "@pi-harness/plugin-auto-mode"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
