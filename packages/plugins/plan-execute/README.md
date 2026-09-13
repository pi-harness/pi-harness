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

Plans are saved as custom entries in the active native session journal and restored from its current branch. New sessions start without a plan; returning to or reopening a session restores its saved plan. Creating another plan replaces only that session branch's current plan. The plugin does not execute commands from the plan. Disk persistence follows the native session manager (in-memory sessions remain transient).

Create and advance write session data; get does not. Calls queued across a session or branch switch are rejected. Invalid saved plans are rejected rather than overwritten. If journal writing fails, the plugin refuses to display or change potentially unsaved state until the session is reopened from disk. Plans from versions that only kept instance-local memory cannot be recovered after that instance unloads.

Successful creation and advancement return the complete bounded plan as model-visible JSON, including step IDs, titles, statuses, and dependencies; rendering details carry a detached copy of the same plan.

`plan_get {}` retrieves the same complete plan without changing any step or replacing the plan. Use it to recover the current progress before resuming work. It reports an error if no plan exists.
