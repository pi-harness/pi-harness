# @pi-harness/plugin-mcp-client

MCP Client — Connect to direct-argv MCP stdio servers with bounded pagination and protocol validation, tool, resource, and prompt bridging, cancellable queued requests, and lifecycle-owned process cleanup.

## Install

```sh
npm install --save-exact @pi-harness/plugin-mcp-client
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: mcp-client
  name: "@pi-harness/plugin-mcp-client"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

A stopped server remains visible as `stopping` until its process closes. Starting another server with the same ID is rejected during that interval; after closure the ID can be reused. Plugin disposal also owns and reaps servers that are still stopping.

One-shot `command` calls and explicit-command server starts use the current native session workspace. Profile-configured servers start from the harness launch workspace, including auto-started servers. Persistent servers keep their starting directory and remain available by ID after session changes; switching sessions does not restart them.

Each tool invocation is bound to its original native session before parameter inspection. Session changes clear the last inventory and call receipt, reject old queued requests before sending them, and discard stale results after process cleanup. Already sent MCP requests and their external effects cannot be undone; a running request may finish or reach its timeout before the stale result is discarded.
