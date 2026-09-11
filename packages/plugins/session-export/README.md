# @pi-harness/plugin-session-export

Session Export — Export the current Pi conversation to a bounded Markdown file inside the workspace without changing session history.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-export
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-export
  name: "@pi-harness/plugin-session-export"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Export contract

An export captures the active runtime session's messages, ID and workspace synchronously when the call begins. Later session changes do not mix new content or metadata into that snapshot. Messages with only whitespace are omitted; otherwise text retains its original indentation, trailing spaces and blank lines. Non-empty text blocks within a message are joined with a newline; images, thinking blocks and tool-call payloads are omitted. Preserving whitespace keeps Markdown code indentation and hard line breaks intact. This is a readable text export, not a complete session archive or a trusted/sanitized document. The report separates exported text sections from source-message and omitted-message counts.

The complete Markdown output must fit within 1 MiB; oversize output is rejected before directory preparation. Files are committed atomically with owner-only 0600 permissions, including confirmed replacements. Without `confirm: true`, create-only commit semantics prevent concurrent exports from overwriting a newly created target. The destination must be a regular `.md` file inside the captured workspace; existing destination symlinks are rejected. Avoid concurrent replacement of parent directories during export.

Cancellation or plugin disposal is checked before preparation and before file commit; a committed write is reported as successful even if cancellation arrives afterward. Parent directories created during preparation can remain after cancellation. The last successful export report is an independent snapshot and identifies its source session/workspace.
