# @pi-harness/plugin-change-verifier

Change Verifier — Combine project tests and Git change review into one explicit verification gate before handoff.

## Install

```sh
npm install --save-exact @pi-harness/plugin-change-verifier
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: change-verifier
  name: "@pi-harness/plugin-change-verifier"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
