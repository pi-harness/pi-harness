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

## Runtime inspection

MCP Client is optional for activation. Without its `piMcp` service, `status` reports `available: false`, the panel shows MCP as unavailable, and configuration previews still work. Enable `@pi-harness/plugin-mcp-client` to query server health or tools. Discovery preserves the client's byte-bounded model-visible JSON, including input schemas and pagination/exact-name instructions; full inventory details remain available to the panel. Health results include their suggestions in model-visible text. Server tool counts are discarded when the MCP provider changes.

## Configuration fragments

Writes are disabled unless `patchPath` is configured. A relative path is resolved under the agent directory. Use a **dedicated standalone MCP fragment**, not the active mixed-plugin profile. `preview` returns the proposed server definition without writing; `apply` requires `confirm: true`, saves the exact previous bytes to `<patchPath>.bak`, then atomically replaces the fragment with mode 0600. Each apply refreshes that backup; it is not a multi-version history. A filesystem failure between the two writes may leave an updated backup without a new fragment.

Repeated applies add server definitions to a single MCP Client entry. Older fragments containing multiple MCP Client entries are consolidated so their duplicate tool registrations do not break startup. Existing server nodes/comments are retained. Duplicate server IDs, malformed YAML, aliases/custom tags, unrelated plugin entries, unknown configuration fields, invalid server commands and more than 128 servers are rejected before changing the fragment or backup. Input and output are limited to 2 MiB; symlink/nonregular fragment targets are rejected.

Applying a fragment does **not** mount it, reload the runtime, or start its servers. To use it, merge its `config.servers` into the one MCP Client entry in your actual profile, or use the standalone entry where no MCP Client is enabled. Do not add another MCP Client instance alongside an existing one. Restart through the normal runtime workflow after reviewing the effective configuration.
