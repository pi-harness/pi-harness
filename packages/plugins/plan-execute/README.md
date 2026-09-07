# @pi-harness/plugin-plan-execute

Plan Execute — Track an explicit multi-step execution plan with progress, dependencies, and completion state in the current session.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plan-execute
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plan-execute
  name: "@pi-harness/plugin-plan-execute"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
