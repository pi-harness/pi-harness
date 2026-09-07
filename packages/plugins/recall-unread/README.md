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
