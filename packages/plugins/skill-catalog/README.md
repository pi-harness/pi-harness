# @pi-harness/plugin-skill-catalog

Skills Catalog — List loaded Agent Skills and safely inspect one through a bounded untrusted-data boundary, plus managed MCP status.

## Install

```sh
npm install --save-exact @pi-harness/plugin-skill-catalog
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: skill-catalog
  name: "@pi-harness/plugin-skill-catalog"
  config: {}
```

Skills Catalog requires the core resource loader, but MCP Client is optional. Without the `piMcp` service, skill listing and reading still work; `action: "mcp"` reports `available: false` and the panel shows MCP as unavailable rather than claiming zero configured servers. To inspect MCP status, separately install and enable `@pi-harness/plugin-mcp-client`; reuse an existing instance instead of adding a duplicate. An empty `servers: []` configuration provides the service without starting external processes.

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Tool contract

`skill_catalog` supports `{ action: "list", query?: string }`, `{ action: "read", name: string }`, and `{ action: "mcp" }`. Unknown actions, fields and fields belonging to other actions are rejected. Queries contain at most 120 characters; names contain 1–64 characters. NUL and accessor properties are rejected.

`list` reads the current resource loader snapshot each time. It returns full matching and loaded counts, up to 200 skills and 100 diagnostics, and a truncation flag. Fields are bounded (name 64, description/diagnostic message 2,000, path 4,096 characters). `modelInvocationDisabled` means the loaded skill is excluded from automatic model invocation; explicit inspection remains available. This flag does not mean the skill failed to load.

`read` finds an exact loaded skill name independently of the list display limit and reads at most 128 KiB of valid UTF-8 from a regular nonsymlink file. It returns permitted content as untrusted data; review/blocked findings withhold the source. These are heuristic checks, not proof of safety or an instruction execution boundary. The tool does not activate skills. Cancellation, disposal or replacement/removal of the loaded skill during the read rejects the result; an in-flight bounded filesystem read completes before cancellation is observed. File contents are read at execution time, not frozen when the loader indexed metadata.

`mcp` returns service availability, up to 100 server IDs, statuses and start times, with full count and truncation. Startup commands and arguments are omitted. It does not start servers or change configuration. The panel reads current snapshots and displays at most eight skills and six server states. All bounded metadata is model-visible and no legacy aliases are retained.
