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

`plan_create` accepts a title, 1–50 string steps, and optional `dependencies: [{ step: 2, dependsOn: [1] }]`. Step IDs start at 1. Dependencies must reference existing steps and cannot form cycles. `plan_advance` accepts `pending`, `in_progress`, `done`, or `skipped`; starting or completing a step requires its prerequisites to be done or skipped. Reopening a prerequisite is rejected while an active or completed dependent still requires it.

Plans track progress in memory for the current plugin instance; they do not execute commands or survive reloads. Creating another plan replaces the current one.
