# @pi-harness/plugin-colleague-skill

Colleague Skill — Create durable, structured handoff packets for another role without hidden agents or external message delivery.

## Install

```sh
npm install --save-exact @pi-harness/plugin-colleague-skill
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: colleague-skill
  name: "@pi-harness/plugin-colleague-skill"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Session ownership

`colleague_handoff` appends a structured packet to the current native Pi session journal. The panel restores the latest valid packet when the native manager or session header changes, including an in-place new session. Before runtime creation, the launch manager supplies the initial journal. Queued calls reject session replacement before execution and before persistence; they never transfer an old request to the newly selected session. Returned packets and panel data are detached snapshots.

The packet records role, objective, context, constraints, files and acceptance criteria. It does not start another agent or deliver an external message. Native journal writes are synchronous; cancellation cannot interrupt an append already in progress. New sessions may remain in memory until the SDK first persists the journal.
