# @pi-harness/plugin-obsidian-sync

Obsidian Sync — Write explicitly requested session notes to a bounded Obsidian vault path without reading unrelated vault files.

## Install

```sh
npm install --save-exact @pi-harness/plugin-obsidian-sync
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: obsidian-sync
  name: "@pi-harness/plugin-obsidian-sync"
  config:
    vaultPath: "notes"
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

Set `vaultPath` to your Obsidian vault directory. Relative paths resolve against the active workspace; absolute vault paths are also supported. Each `obsidian_sync` call requires `confirm: true`, a relative `.md` note path, and 1–524288 UTF-8 bytes. Existing notes are replaced atomically with their permission bits preserved. Cancelled calls are checked before committing; cancellation after the atomic rename does not roll back a committed note.

Native session changes clear the last-sync receipt. Relative vault paths follow the current session workspace; an absolute vault remains fixed. Queued and staged writes stay bound to the session that requested them and are rejected if that session changes before publication. A change after the atomic rename cannot undo a committed note; preparation may leave empty parent directories.
