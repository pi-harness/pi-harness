# @pi-harness/plugin-graph-memory

Graph Memory — Store bounded typed task, skill, and event nodes with validated directed relations, atomic locked persistence, and inspectable cross-session search.

## Install

```sh
npm install --save-exact @pi-harness/plugin-graph-memory
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: graph-memory
  name: "@pi-harness/plugin-graph-memory"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Search and continuation

Search accepts non-empty 1–160-character queries, including single-character labels. The model receives JSON containing full selected nodes (including provenance), directed relations, total matches and explicit truncation/continuation fields, identical to tool details. Each response is limited to 128 KiB of serialized UTF-8 JSON; node summaries are never silently cropped.

`limit` defaults to 12 and is capped at 50 nodes. Continue nodes with `offset: nextOffset` until it is `null`. Incident relations are scoped to the nodes returned on that page, with at most `limit * 4` per response and the remaining byte budget. Keep query, kind, limit and node offset unchanged and use `relationsOffset: nextRelationsOffset` to read remaining relations before moving to the next node page. Each side has its own total/truncation metadata; `relationsTotal` is not the total number of edges in the whole graph. Edges may be repeated across different node pages.

Offsets are validated non-negative integers (nodes ≤ 2,000, relations ≤ 5,000). Pagination reads the current persisted graph each time, not a transaction snapshot: writes between requests can change ordering, so restart a scan after edits. A stored record with oversized metadata that cannot fit alone is rejected with an explicit byte-limit error rather than skipped or clipped. The existing 4 MiB file bound and write/cancellation/confirmation protections are unchanged.
