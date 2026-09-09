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

`session_search` accepts only `{ query: string }`, with 1–120 characters and no NUL. It searches user and assistant text from native version-3 JSONL files in the active session manager's directory, filtering by the active workspace. Historical branches are included; image content, thinking, tool outputs, custom messages and other metadata are excluded. Matching is case-insensitive text matching, not semantic search.

Directory enumeration stops at 4,096 entries or 200 JSONL candidates in filesystem order, without a newest-first guarantee. Each file has a 4 MiB limit; the search has a 32 MiB read budget. Failed reads charge their full remaining per-file allowance; successful reads charge actual bytes. Symlinks, nonregular files, invalid UTF-8/JSON, unsupported headers and other-workspace journals are skipped and counted. Directory access errors are reported; a missing directory means there are no persisted sessions yet.

The result reports scanned/skipped counts, byte budget used and truncation. `total` counts matching sessions among successfully scanned files; at most 100 session results are returned, each with the full `totalHits` and up to 10 previews of 500 characters. These counts do not claim coverage of unscanned or skipped files. The panel shows the latest completed search from the current native session, with at most eight session cards; run the tool again to refresh it.

The complete bounded report is model-visible. Search is read-only and does not create an atomic snapshot across journals; avoid concurrent journal edits when repeatable results matter. Cancellation, plugin disposal and changes to the active manager/session/workspace prevent publication of the pending report. In-flight bounded file reads finish before cancellation is observed.

The invocation captures its native session before parameter inspection. Replacing that session or its manager, ID, workspace or journal directory clears the cached report; stale operations cannot publish into the new session.
