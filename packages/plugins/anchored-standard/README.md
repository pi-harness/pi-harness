# @pi-harness/plugin-anchored-standard

Anchored Standard — Audit agent trajectories against an explicit tool-call allowlist and flag activity outside the anchored run.

## Install

```sh
npm install --save-exact @pi-harness/plugin-anchored-standard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: anchored-standard
  name: "@pi-harness/plugin-anchored-standard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
