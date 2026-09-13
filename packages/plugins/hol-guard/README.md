# @pi-harness/plugin-hol-guard

HOL Guard — Audit tool arguments and preflight text for destructive commands, sensitive paths, credentials, and remote exfiltration. Advisory only: reports risk, does not block execution.

## Install

```sh
npm install --save-exact @pi-harness/plugin-hol-guard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: hol-guard
  name: "@pi-harness/plugin-hol-guard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Reports and cancellation

`hol_guard_scan` returns the full risk report as model-visible JSON: risk label, score, scanned byte count and finding explanations. The panel shows the latest explanations as well as aggregate counts. `blocked` is a high-risk label, not proof that an operation was prevented; this plugin remains advisory.

Inputs that cannot be serialized are reported as `review` with a `scan_unavailable` finding and zero scanned bytes, never as successfully scanned safe input. Oversized scans retain their existing incomplete-scan warning. Neither result proves the original input is safe, and reports do not contain the original scanned text.

Explicit scans check caller cancellation and plugin disposal before scheduling, before scanning and before publishing a receipt. Cancelled scans do not change audit counters or receipts. The scanner is synchronous once running, so cancellation cannot interrupt a JavaScript step already executing.
