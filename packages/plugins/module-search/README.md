# @pi-harness/plugin-module-search

Module Search — Find imports, exports, and declared symbols in bounded workspace source files without modifying them.

## Install

```sh
npm install --save-exact @pi-harness/plugin-module-search
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: module-search
  name: "@pi-harness/plugin-module-search"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native sessions

Searches use the active native session workspace, or the harness launch directory when no runtime exists. Session, manager, session ID, or cwd changes clear the last report. A pending search rejects on a session change or cancellation instead of returning or caching stale results; retained tools reject after plugin disposal.
