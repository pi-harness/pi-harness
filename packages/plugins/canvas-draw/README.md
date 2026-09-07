# @pi-harness/plugin-canvas-draw

Canvas Draw — Generate validated, bounded Mermaid flowchart source from structured nodes and edges in the workspace UI.

## Install

```sh
npm install --save-exact @pi-harness/plugin-canvas-draw
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: canvas-draw
  name: "@pi-harness/plugin-canvas-draw"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
