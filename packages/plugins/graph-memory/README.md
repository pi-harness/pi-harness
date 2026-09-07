# @pi-harness/plugin-graph-memory

Graph Memory — Store bounded typed task, skill, and event nodes with validated directed relations, atomic locked persistence, and inspectable cross-session search.

## Install

```sh
npm install --save-exact @pi-harness/plugin-graph-memory
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: graph-memory
  name: "@pi-harness/plugin-graph-memory"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
