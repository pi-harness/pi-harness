# @pi-harness/plugin-session-search

Session Search — Search persisted Pi JSONL sessions for matching user or assistant text without modifying session files.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-search
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-search
  name: "@pi-harness/plugin-session-search"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
