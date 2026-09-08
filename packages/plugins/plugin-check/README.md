# @pi-harness/plugin-plugin-check

Plugin Check — Inspect installed plugin manifests and report unsafe, malformed, or incompatible extension metadata before loading it.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-check
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-check
  name: "@pi-harness/plugin-plugin-check"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

The checker recognizes independently published Cordis npm plugins by package keywords and the Cordis peer dependency, including directories without a prefix. Standard npm installation and a matching YAML Cordis profile example are required for a clean report. Legacy DSH directory aliases, patch files and installation commands are not supported; existing patch files are ignored.

Directory scans inspect at most 2,000 entries and return at most 50 repositories (configurable via `scanLimit`), with a `truncated` flag when the scan stops early. Source reads are bounded and stay inside each repository. Checks do not import, build, or execute plugin code. Import-extension diagnostics are regex heuristics, not a complete syntax or security audit.

Checks use the current native session workspace. Session replacement clears the previous report, and results from an inspection whose workspace changed are rejected. Before a native runtime exists, checks use the launch workspace.
