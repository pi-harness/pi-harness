# @pi-harness/plugin-memory

Memory — Persist bounded cross-session notes with explicit recall and update operations.

## Install

```sh
npm install --save-exact @pi-harness/plugin-memory
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: memory
  name: "@pi-harness/plugin-memory"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

`memory_search` accepts non-empty trimmed queries of 1–128 characters, including single-character keys and Chinese keywords, and matches keys, values or tags case-insensitively. The store is shared across sessions in the same configured agent directory; writes replace an existing key and deletes require `confirm: true`.
