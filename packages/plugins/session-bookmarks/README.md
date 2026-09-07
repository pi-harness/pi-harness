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
