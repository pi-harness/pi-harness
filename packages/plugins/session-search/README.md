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

## Search scope and limits

`session_search` accepts `{ query: string, cursor?: string }`, with a query of 1–120 characters and no NUL. Omit `cursor` to start a search. Pass the returned `nextCursor` with the same query to continue, even when a page has zero matches, until `nextCursor` is null. It searches user and assistant text from native version-3 JSONL files in the active session manager's directory, filtering by the active workspace. Historical branches are included; image content, thinking, tool outputs, custom messages and other metadata are excluded. Matching is case-insensitive text matching, not semantic search.

Each page stops at 4,096 entries, 200 JSONL candidates, 100 matching sessions or its read budget, in filesystem order without a newest-first guarantee. Continuation retains the next unprocessed entry rather than reopening and rescanning the directory. Each file has a 4 MiB limit and each page a 32 MiB read budget; a full file allowance is reserved before starting another file. Failed reads charge their allowance; successful reads charge actual bytes. Symlinks, nonregular files, invalid UTF-8/JSON, unsupported headers and other-workspace journals are skipped and counted. Directory access errors are reported; a missing directory means there are no persisted sessions yet.

The result reports per-page scanned/skipped counts, byte budget used, truncation and `nextCursor`. `total` counts this page's matching sessions, not all sessions across pages; every counted session is returned, each with the full `totalHits` and up to 10 previews of 500 characters. These counts do not claim coverage of unscanned or skipped files. A null cursor means enumeration ended, not that skipped files or clipped previews were recovered. The panel shows the latest completed page from the current native session, with at most eight session cards.

Only one opaque, single-use cursor is retained per plugin instance. It is tied to the exact trimmed query and native session context, expires after five idle minutes, and is invalidated by a new search, cancellation during execution, context replacement or disposal. Directory resources are closed on exhaustion or invalidation. Unknown, consumed, expired and wrong-query cursors are rejected; restart without a cursor. Continuation does not survive process restart. Concurrent calls are rejected without advancing the active scan. Directory or journal changes between pages are not snapshot-isolated.

Native context replacement is detected on the next tool execution or panel read, before the old cursor can be used or displayed. With no further interaction, the idle expiry closes the one retained directory handle within five minutes; cleanup is not an immediate native-navigation event subscription.

The complete bounded report is model-visible. Search is read-only and does not create an atomic snapshot across journals; avoid concurrent journal edits when repeatable results matter. Cancellation, plugin disposal and changes to the active manager/session/workspace prevent publication of the pending report. In-flight bounded file reads finish before cancellation is observed.

The invocation captures its native session before parameter inspection. Replacing that session or its manager, ID, workspace or journal directory clears the cached report; stale operations cannot publish into the new session.
