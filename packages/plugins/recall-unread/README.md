# @pi-harness/plugin-recall-unread

Recall Unread — Read-only bounded discovery with strict UTF-8 session reads finds current workspace conversations ending in an unanswered user message, uses cached startup inventory, and rescans only on explicit tool calls.

## Install

```sh
npm install --save-exact @pi-harness/plugin-recall-unread
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: recall-unread
  name: "@pi-harness/plugin-recall-unread"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Behavior and limits

“Unread” means a persisted session whose last message entry is a user message with non-empty text. It is not a read receipt or a general unfinished-task detector. Assistant errors, tool results and image-only user messages do not qualify. Only the current workspace's session directory is scanned, excluding the active session and symbolic-link files. Sessions are never modified or resumed.

The panel caches the startup scan or the latest successful explicit `session_recall_unread` call for the active native session. Switching the runtime session, manager, session ID, path, workspace, or session directory clears the old inventory and shows an unscanned state; run the tool to scan the newly active session. The scan counter counts successful scans over the plugin lifetime. Failed or cancelled scans preserve successful inventory only within the same session. Requests capture their native session before parameter inspection and queueing, then check it before discovery, after asynchronous reads, and before returning results; a queued or running request cannot adopt a replacement session.

Discovery inspects at most 4,096 directory entries and reads the newest 100 candidate sessions by default (configurable up to 500), with at most eight concurrent reads and 4 MiB per UTF-8 file. Unread previews contain at most 500 UTF-16 code units; the panel shows 50 items and the tool 100. Inventory flags distinguish discovery, scan and display truncation. Malformed, unreadable, oversized or foreign-workspace files are skipped.

The model receives JSON identical to tool details, including each selected session's ID, native journal path, workspace, title, timestamp, message count and bounded preview. `previewCharacters: 500` describes the preview limit, not a complete transcript. Model-visible pages are capped at 128 KiB of serialized UTF-8 JSON without further clipping selected records.

Use optional integer `offset` (0–500, default 0) and `limit` (1–100, default 100) to page through matched results. Follow `nextOffset` with the same query and limit until it is `null`; `total` counts matched sessions within the scanned candidates, `returned` counts this page, and `inventory.resultTruncated` indicates that this page omits some matches. Discovery/scan truncation is independent of paging: `nextOffset: null` does not mean the whole directory was scanned. Every call rescans; ties in modification time are ordered by journal path, but concurrent edits can reorder pages. This is not a transactional snapshot, and paging does not bypass the configured scan bound. The panel keeps the full unfiltered scanned inventory independently of the selected tool page.
