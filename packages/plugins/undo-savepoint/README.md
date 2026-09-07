# @pi-harness/plugin-undo-savepoint

Undo Savepoints — Create inspectable savepoints before agent changes so the workspace can be restored safely.

## Install

```sh
npm install --save-exact @pi-harness/plugin-undo-savepoint
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: undo-savepoint
  name: "@pi-harness/plugin-undo-savepoint"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
