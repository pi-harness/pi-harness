# @pi-harness/plugin-session-compare

Session Compare — Compare two persisted Pi sessions by message role and text without modifying either session file.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-compare
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-compare
  name: "@pi-harness/plugin-session-compare"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Comparison scope

Comparison is positional across non-empty text messages in journal order, including entries from historical branches. It trims text boundaries and compares role plus full normalized text; an insertion shifts later positions and can count the following messages as changed. It is not an edit-distance or active-branch comparison. Images, tool-call arguments, custom messages, metadata and empty text are excluded: matching text projections do not prove identical sessions.

Full added/removed counts are returned separately from previews (40 per side, 4,000 UTF-16 code units each), with explicit truncation flags covering both omitted messages and cropped text. Shared messages are compared in full and do not trigger preview truncation. The panel displays at most four previews per side and warns when the tool's previews were truncated; the tool text includes the same warning. Any session in the active SDK session directory can be selected by exact ID, full path or filename, including older sessions beyond the first 200 results and legacy headers without cwd or timestamp. Explicit filenames and full paths resolve directly through the authoritative selected-file reader; fallback ID discovery streams the directory and reads at most the 64 KiB first-line header from each regular nonsymlink JSONL file, without retaining a full inventory or silently capping its size. Each selected file is read through a bounded 4 MiB reader, rejecting invalid UTF-8, malformed JSONL, files from another declared workspace and files whose discovered session identity changed before reading. The files are independent snapshots, not an atomic pair; avoid editing them while comparing.

Cancelled and disposed requests do not replace the last successful report in the same session. Native session changes clear the cached comparison; stale requests cannot publish into the new session. The session is captured before parameter inspection. Discovery checks cancellation between directory entries and bounded header chunks; selected-file reads check the signal between chunks so large files do not continue scanning after cancellation. Reports returned to tools and panels do not share mutable state.
