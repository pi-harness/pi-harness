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
