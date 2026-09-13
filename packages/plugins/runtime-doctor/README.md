# @pi-harness/plugin-runtime-doctor

Runtime Doctor — Audit workspace, agent directory, model, runtime, MCP servers, and extension errors in one read-only report.

## Install

```sh
npm install --save-exact @pi-harness/plugin-runtime-doctor
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: runtime-doctor
  name: "@pi-harness/plugin-runtime-doctor"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Diagnostic scope

Each tool call and panel read checks the current session workspace and current session model, falling back to launch configuration only when no runtime session exists. Directory checks require directories, not merely existing files. An inaccessible path is reported as unavailable without claiming it is missing. MCP reports compare running servers with configured servers; stopped or stopping entries produce a warning. No configured MCP server is valid because MCP is optional.

Runtime status confirms service registration only. It does not prove the model API, credentials, network, disposed runtime state or MCP tools are healthy; no external probes or repairs are performed. Extension errors count events since this plugin was loaded and are not a current-health resettable counter. Agent directory always refers to the launch configuration.

Cancellation and disposal reject pending inspections and retained calls. Session replacement during directory inspection rejects mixed-session results. Registration failure cleans up the tool and event listener.
