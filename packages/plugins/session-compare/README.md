# @pi-harness/plugin-session-compare

Session Compare — Compare two persisted Pi sessions by message role and text without modifying either session file.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-compare
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-compare
  name: "@pi-harness/plugin-session-compare"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
