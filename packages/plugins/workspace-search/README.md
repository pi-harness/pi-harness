# @pi-harness/plugin-workspace-search

Workspace Search — Search bounded text files in the active workspace with ignored directories and binary content excluded.

## Install

```sh
npm install --save-exact @pi-harness/plugin-workspace-search
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: workspace-search
  name: "@pi-harness/plugin-workspace-search"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Search contract

`workspace_search` performs literal substring matching on individual UTF-8 lines, not regular expressions or multi-line matching. Queries are trimmed and must contain 1–256 characters. Matching defaults to Unicode lowercase comparison; `caseSensitive: true` uses exact case. `maxResults` defaults to 100 and is clamped to 1–100; nonfinite values, invalid field types, unknown parameters and accessor properties are rejected.

The active native Pi session manager supplies the workspace; the launch directory is used only when no native runtime exists. The optional `path` is resolved canonically inside that workspace and is limited to 512 characters without backslashes. Both a file and a directory may be searched. Discovered symlinks are skipped; explicitly requested paths that resolve inside the workspace may be followed, while outside targets are rejected. Files are rechecked against workspace containment before reading. This is not an atomic snapshot or protection against every hostile concurrent filesystem replacement.

## Resource and result limits

Traversal stops at 2,000 files, 512 directories, depth 16 or a global budget of 4,096 directory entries, including skipped entries. Directories are streamed and the discovered portion is sorted by name. `.git`, `node_modules`, `.pi`, `dist`, and `build` directories are skipped. The plugin does not implement Git ignore rules. Unreadable descendants produce a partial report; missing or unreadable requested roots fail.

Individual files are limited to 2 MiB and must be regular, valid UTF-8 text without NUL bytes. The cumulative content-read budget is 64 MiB; failed bounded-read attempts conservatively consume their reserved allowance, while `readBytes` counts bytes successfully returned by the reader. The bounded reader may read an additional byte to detect growth beyond a file limit. Oversize, unreadable, binary and invalid UTF-8 files increment `skippedFiles`. A file disappearing during a scan is skipped rather than discarding earlier matches.

Each matching line contributes one result, regardless of how many occurrences it contains. Previews contain at most 500 UTF-16 code units plus omission markers, centered near the first match; surrogate pairs are not split. Case-insensitive clipping maps lowercase positions back to the original text, including length-changing Unicode folds. A result limit, traversal/read limit, skipped file or clipped preview marks `truncated: true`; reaching an exact limit may conservatively mark the search incomplete. `matchCount` is the number of collected matching lines, not the total possible matches.

Both model-visible text and details contain bounded JSON with matches, scanned/skipped file counts, entry counts, read bytes and truncation. Details and panel snapshots are detached copies. The panel shows the active workspace, query, path, counts, completeness warning and the first five collected matches. Caller cancellation, disposal or an obsolete native session prevents publishing results; changing the session object, manager, ID or cwd clears cached results. Individual filesystem reads are not forcibly interrupted. A failed request retains the previous completed report in the same session.

No shell, model, upload, dependency installation or file write is performed by the plugin. File contents returned as matches are workspace data, not instructions to execute.
