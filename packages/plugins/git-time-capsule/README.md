# @pi-harness/plugin-git-time-capsule

Git Time Capsule — Capture the current unstaged tracked Git diff as a byte-exact, validated undo capsule without external diff or textconv helpers, then reverse-apply it only after explicit confirmation.

## Install

```sh
npm install --save-exact @pi-harness/plugin-git-time-capsule
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: git-time-capsule
  name: "@pi-harness/plugin-git-time-capsule"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native workspace

Capture and restore use the current native session workspace, captured before parameters are inspected or operations enter the queue. A changed session, manager, native session ID or workspace clears the activity panel and rejects old queued operations. Restore rechecks scope after patch validation immediately before launching the Git write. An already launched Git write cannot be rolled back by a later session switch; its obsolete result is not published to the new session.

The capsule inventory remains shared in the configured agent directory. Selecting a capsule with explicit confirmation reverse-applies it to the current workspace if Git validates it; capsules do not assert repository provenance. Before the native runtime is available, the launch workspace is used.
