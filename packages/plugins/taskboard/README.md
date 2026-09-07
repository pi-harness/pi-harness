# @pi-harness/plugin-taskboard

Taskboard — Track agent tasks, statuses, and dependencies in a durable project board.

## Install

```sh
npm install --save-exact @pi-harness/plugin-taskboard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: taskboard
  name: "@pi-harness/plugin-taskboard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
