# @pi-harness/plugin-session-bookmarks

Session Bookmarks — Persist labels for important native Pi session entries without changing the underlying transcript.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-bookmarks
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-bookmarks
  name: "@pi-harness/plugin-session-bookmarks"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Behavior

`session_bookmarks` adds or replaces a native label by `entryId`, lists current-session labels, or removes one by `bookmarkId` (the target entry ID). Labels contain 1–120 characters after trimming. The target must already exist in the current session. Data follows the active session manager and survives reopening a persisted session; in-memory sessions remain temporary. Once the native runtime is active, reads and writes use its current manager even when the launch service still points to the original manager.

Cancelled, disposed, or queued calls whose session changed are rejected before writing. Native journal writes are synchronous and cannot be interrupted once started. If persistence throws, the SDK may already have modified its in-memory journal: the plugin refuses further reads and writes for that session until it is reloaded from disk. It does not claim to roll back the SDK or repair a partially written journal.
