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

## Model-visible discovery and results

`mcp_list_tools` includes input schemas and `mcp_list_prompts` includes argument definitions in model-visible JSON. Both accept optional `offset` (0–1000) and `limit` (1–100, default 20). Each model-visible page is limited to 64 KiB of UTF-8 and reports `total`, `shown`, `nextOffset` and `truncated`. Continue at `nextOffset` until it is null. Discovery reruns on each call; these pages are observations, not a frozen remote snapshot. The existing full validated inventory remains in `details` and the panel cache.

A descriptor larger than the page budget is represented by its name, a short description and `descriptorOmitted: true`, never a silently clipped schema. Supply exact `name` instead of offset/limit to read one complete descriptor, up to the existing 1 MiB response-size ceiling. Unknown names and invalid pagination fail explicitly. Names remain discoverable even when their definitions require individual retrieval. Remote pagination still has the existing 100-page and 1000-item limits.

`mcp_call` preserves `structuredContent` as JSON text for the model, including when a server returns an empty content array. An identical JSON text block is not duplicated. The negotiated 2025-06-18 protocol expects structured content to be an object; malformed values fail explicitly. MCP `isError` results remain tool errors rather than successful receipts.
