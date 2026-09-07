# @pi-harness/plugin-better-sidebar

Better Sidebar — Show a compact workspace, Git, and session overview beside the conversation without modifying files.

## Install

```sh
npm install --save-exact @pi-harness/plugin-better-sidebar
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: better-sidebar
  name: "@pi-harness/plugin-better-sidebar"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
