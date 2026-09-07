# @pi-harness/plugin-mcp-panel

MCP Panel — Inspect MCP server health and tools, preview profile patches, and apply changes only with an explicit confirmation and backup.

## Install

```sh
npm install --save-exact @pi-harness/plugin-mcp-panel
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: mcp-panel
  name: "@pi-harness/plugin-mcp-panel"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
