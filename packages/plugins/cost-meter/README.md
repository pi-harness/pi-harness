# @pi-harness/plugin-cost-meter

Cost Meter — Track runtime-reported costs as UTC daily increments in a bounded local ledger, with session snapshots and optional daily budget monitoring; no model prices are guessed.

## Install

```sh
npm install --save-exact @pi-harness/plugin-cost-meter
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: cost-meter
  name: "@pi-harness/plugin-cost-meter"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
