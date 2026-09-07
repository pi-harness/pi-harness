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
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
