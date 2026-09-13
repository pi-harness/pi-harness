# @pi-harness/plugin-fail-logger

Failure Logger — Aggregate bounded extension, Agent, and non-aborted compaction failures through descriptor-safe event inspection, safe diagnostic summaries, and occurrence counts without retaining full payloads.

## Install

```sh
npm install --save-exact @pi-harness/plugin-fail-logger
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: fail-logger
  name: "@pi-harness/plugin-fail-logger"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
