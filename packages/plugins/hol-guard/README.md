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
