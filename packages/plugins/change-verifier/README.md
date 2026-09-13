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

## Attempt state

Starting a valid verification clears the previous gate result. The panel distinguishes running, completed, failed and cancelled attempts and includes a bounded provider error when execution fails. A failed attempt cannot reuse an earlier green pass; the completed-run count increases only when both providers return and a gate report is computed. Session/workspace replacement clears this state, and obsolete operations cannot publish into the new scope. Rejected script parameters do not start a verification or replace the last result.
