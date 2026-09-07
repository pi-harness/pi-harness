# @pi-harness/plugin-turn-rewind

Turn Rewind — Scans a bounded current branch for user turns, supports queued serialized cancellable rewinds after the agent settles, and navigates the native session tree while preserving abandoned branches.

## Install

```sh
npm install --save-exact @pi-harness/plugin-turn-rewind
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: turn-rewind
  name: "@pi-harness/plugin-turn-rewind"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
