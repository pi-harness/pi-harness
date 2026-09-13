# @pi-harness/plugin-mock-server

Mock Server — Start a local, bounded HTTP mock server from explicit routes for integration testing without external services.

Start and status tools return the same JSON state to the model and the panel: running state, local URL, route count, latest request and latest error. Route bodies and request bodies are not included in this diagnostic state.

## Install

```sh
npm install --save-exact @pi-harness/plugin-mock-server
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: mock-server
  name: "@pi-harness/plugin-mock-server"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
