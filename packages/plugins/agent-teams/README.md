# @pi-harness/plugin-agent-teams

Agent Team Board — Maintain a bounded, session-local collaboration ledger of named roles, dependency-aware tasks, and mailbox notes without spawning agents or sending external messages.

## Install

```sh
npm install --save-exact @pi-harness/plugin-agent-teams
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: agent-teams
  name: "@pi-harness/plugin-agent-teams"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
