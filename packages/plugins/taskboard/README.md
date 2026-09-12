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

## Workflow and dependencies

Tasks belong to the active native session's workspace. Before runtime initialization the launch workspace is used. Switching workspaces changes the visible board without moving existing tasks. SQLite storage remains under the configured agent directory. Task keys are unique across all workspaces in that database.

`taskboard_create` and `taskboard_update` accept `dependsOn`, an array of up to 32 unique task keys in the same workspace. Updates replace the dependency set; an empty array clears it. Self-dependencies, cycles and missing/cross-workspace prerequisites are rejected transactionally. A failed creation or dependency update rolls back the task row and dependency changes together.

Tasks start in `backlog`. The update tool supports `backlog`, `todo`, `in_progress`, `in_review`, `blocked` and `canceled`; only `taskboard_accept` can set `done`, and requires `confirm: true`, an `in_review` task, and every prerequisite already `done`. Done and canceled tasks are terminal and cannot be updated. A canceled prerequisite blocks acceptance until the dependent task's dependency set is changed. The confirmation flag is a tool contract, not proof of an external human approval. Within each workspace, mutation timestamps advance by at least one millisecond so rapid creates and updates retain their actual order even when the wall clock does not advance.

All tools return complete bounded JSON. Listing retains at most 100 tasks (20 by default), reports the full matched count and `truncated`, and performs literal case-insensitive substring matching over key/title/description. It still scans the workspace's tasks; the limit bounds returned details, not total scan work. The panel aggregates all seven status counts and displays all eight backend-bounded recent tasks with dependency keys in a scrollable list. Long titles and dependency lists wrap inside narrow cards instead of being clipped or widening the panel.

Titles contain 1–200 UTF-16 units, descriptions at most 16 KiB of UTF-8, and dates must be exact valid `YYYY-MM-DD` calendar dates. Database writes use immediate transactions and a local mutation queue, with a one-second SQLite lock timeout. New databases use mode 0600. Cancellation/context changes are checked before database operations and queued mutations; synchronous SQLite work already underway is not interruptible. No automatic session-file modifications or external network requests are performed.
