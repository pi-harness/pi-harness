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

## Native session ownership

Board reads and writes use the current native runtime manager; the launch manager supplies initialization before runtime creation. Recovery reads the active branch. Queued actions capture the manager and session header and reject replacement, including in-place new sessions, before accessing or changing the board. Tool results and panel snapshots remain detached from journal state.

The collaboration ledger stores roles, tasks and local mailbox notes. It does not spawn agents or deliver messages outside the session. Native journal appends are synchronous and cannot be interrupted after they begin.

`read_messages` returns at most 25 matching notes per call. Follow the returned `nextOffset` to retrieve later pages. When `unreadOnly: true`, returned notes leave the unread result set, so `nextOffset` intentionally remains at the current offset until that page is exhausted. Continuation assumes the same session, recipient and filter with no intervening mailbox cleanup; restart at offset `0` after changing that result set.

## Journal contract

Recovery accepts only valid `journalVersion: 1` checkpoint and delta entries. Unversioned snapshots are ignored; no legacy field repair, dependency-state migration or compatibility aliases are provided. Inconsistent checkpoints and deltas are rejected as a whole, while earlier valid entries remain recoverable. Delta revisions must connect to the recovered checkpoint. Current derived dependency and member states must be consistent at each revision.

The active branch is scanned back to a recoverable checkpoint, including beyond the initial 10,000-entry window when necessary. This is not a hard bound on SDK journal inventory or recovery I/O. Current mutations enforce the existing eight-MiB state limit, bounded collections, dependency checks and model/panel preview limits.
