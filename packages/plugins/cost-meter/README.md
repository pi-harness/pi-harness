# @pi-harness/plugin-cost-meter

Cost Meter — Track runtime-reported costs as UTC daily increments in a bounded local ledger, with session snapshots and optional daily budget monitoring; no model prices are guessed.

`cost_report` returns a model-visible JSON summary including session, UTC daily and cumulative USD costs, configured budget and percentage, ledger display limit/count and the latest persistence error. It preserves the ledger's six-decimal precision instead of rounding small costs to zero. The existing `details` and panel retain the selected ledger entries; the model summary does not dump session identifiers/history. These are SDK-reported costs, not a provider invoice. A daily budget only monitors usage; it does not stop runs.

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
