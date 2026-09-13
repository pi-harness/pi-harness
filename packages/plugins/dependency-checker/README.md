# @pi-harness/plugin-dependency-checker

Dependency Checker — Run a bounded, offline, read-only check of workspace package.json and requirements*.txt manifests for local package presence, duplicate declaration consistency, unresolved constraints, and unsupported Python directives.

## Install

```sh
npm install --save-exact @pi-harness/plugin-dependency-checker
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: dependency-checker
  name: "@pi-harness/plugin-dependency-checker"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native workspace and model diagnostics

Tool calls and automatic panel scans use the current native session workspace, falling back to the launch directory before a native session is available. Replacing the session, changing its ID, or changing its workspace invalidates cached reports and pending scans. The panel then scans the new workspace; a failed scan in the same session preserves its last successful report. Cancellation and disposal discard pending results.

The model receives JSON containing manifest metadata, category counts, missing and invalid package names, and conflicting or unresolved constraints. The summary is limited to 32 KiB, 20 entries per category, four constraints per group, and 512 UTF-16 code units per displayed value, including the truncation marker; `truncated` indicates omitted or shortened diagnostics. Tool details and the panel retain the complete bounded scan report. Checks remain offline and read-only.
