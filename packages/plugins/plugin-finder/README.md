# @pi-harness/plugin-plugin-finder

Plugin Finder — Search a configured npm-compatible registry for Pi plugins with bounded queries and explicit installation handoff.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-finder
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-finder
  name: "@pi-harness/plugin-plugin-finder"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

Search reads at most 250 registry candidates within a 1 MiB response limit, matches every query term against package names and descriptions, prioritizes name matches, and returns the configured result limit. `total` counts matches in the inspected candidates; `registryTotal` is the registry candidate count. `truncated` indicates incomplete candidate coverage or omitted matches. Registry scores are npm search relevance scores, not user ratings. No package is installed or executed.

The model receives the complete bounded JSON report, including descriptions, npm links, relevance scores and completeness metadata, also for empty results. The panel displays all returned results (at most 25) in a scrollable list.

Caller cancellation and plugin disposal cancel an in-progress registry response-body read, including a body that stalls after response headers arrive. A cancelled search does not replace the last successful panel result.
