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

The panel is a cached snapshot from startup or the latest successful explicit `session_recall_unread` call; changing sessions does not automatically refresh it. Failed or cancelled scans preserve the previous successful inventory and show their status. A scan captures its workspace and active session before discovery and rejects publication if that session changes while files are being read; retry to scan the newly active session.

Discovery inspects at most 4,096 directory entries and reads the newest 100 candidate sessions by default (configurable up to 500), with at most eight concurrent reads and 4 MiB per UTF-8 file. Unread previews contain at most 500 UTF-16 code units; the panel shows 50 items and the tool 100. Inventory flags distinguish discovery, scan and display truncation. Malformed, unreadable, oversized or foreign-workspace files are skipped.
