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
