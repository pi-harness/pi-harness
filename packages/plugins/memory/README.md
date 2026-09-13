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

`memory_search` accepts non-empty trimmed queries of 1–128 characters, including single-character keys and Chinese keywords, and matches keys, values or tags case-insensitively. Results use bounded pages of at most eight records and 128 KiB of serialized details; pass `nextOffset` back as `offset` until it is `null`. Individual values are previewed at up to 8 KiB and report `valueBytes`, `shownValueBytes`, and `valueTruncated` so model-visible output remains bounded. The store is shared across sessions in the same configured agent directory; writes replace an existing key and deletes require `confirm: true`.

The panel exposes at most eight recent memories and at most eight results from the latest search, with explicit shown/total/truncation metadata for both inventories. It displays every returned recent memory, including all 16 bounded tags, and keeps maximum-size keys and values accessible through wrapping and bounded scrolling. Persisted records use an exact schema with canonical non-decreasing timestamps; malformed or contradictory data fails visibly instead of being rendered as healthy state.
