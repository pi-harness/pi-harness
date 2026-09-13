# @pi-harness/plugin-openpets

OpenPets — Keep a bounded durable companion state from validated recent session entries without retaining message contents, with descriptor-safe actions and explicit persistence health.

## Install

```sh
npm install --save-exact @pi-harness/plugin-openpets
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: openpets
  name: "@pi-harness/plugin-openpets"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Session ownership

The companion follows the current native runtime manager. A manager or session-header change restores the latest valid state from that session's bounded recovery window, or starts at energy 80 with zero interactions. Recovery metadata and persistence health reset for the newly selected session. Before runtime creation, the launch manager supplies the initial journal.

Panel reads, actions and relevant session events refresh ownership. Queued actions capture the current manager/header and reject session changes before updating state or writing. Event reactions persist to the current session journal. Persistence health counts attempts and failures since the current session was selected; switching back restores persisted companion state, not historical health counters.

The existing 10,000-entry recovery window and field limits still apply. Synchronous journal appends cannot be interrupted after they begin. A failed append remains visible in persistence health; the plugin does not claim to roll back SDK or filesystem partial writes.
