# @pi-harness/plugin-archify

Architecture Map — Build a bounded, read-only architecture map from workspace components and package dependencies.

## Install

```sh
npm install --save-exact @pi-harness/plugin-archify
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: archify
  name: "@pi-harness/plugin-archify"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Workspace and cancellation

`architecture_map` scans the current native session workspace. Before a native session is available, it uses the harness launch directory. Replacing the session, changing its ID, or changing its workspace clears the previous panel report; a scan started in an older scope cannot publish its result into the current session.

Tool cancellation and plugin disposal cancel directory traversal and discard pending reports. An already-started bounded package manifest read may finish before cancellation is observed. A failed scan in the same session preserves the last successful report. Architecture scanning is read-only.
