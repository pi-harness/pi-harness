# @pi-harness/plugin-canvas-draw

Canvas Draw — Generate validated, bounded Mermaid flowchart source from structured nodes and edges in the workspace UI.

The tool and panel return Mermaid source, not a rendered drawing. Invalid or cancelled requests preserve the last successful diagram. The diagram is kept in memory across session switches until the plugin is unloaded; calls retained after unloading are rejected. Failed panel registration rolls back the tool registration so the plugin can be enabled again after the conflict is resolved.

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
