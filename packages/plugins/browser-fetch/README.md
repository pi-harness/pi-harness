# @pi-harness/plugin-browser-fetch

Browser Fetch — Fetch public HTTP and HTTPS pages as bounded text with descriptor-safe inputs, DNS pinning, per-redirect private-network validation, textual MIME enforcement, cancellation, a whole-request timeout, and validated fail-closed panel reporting.

Response bodies are capped at 512 KiB. If more body data exists, the model-visible envelope explicitly says that the page is incomplete; a body exactly at the limit is not marked truncated. The panel separately reports its shorter preview limit. Remote text remains enclosed as untrusted data.

Caller cancellation and plugin disposal cancel both the network request and an already-started response-body read, including a body that stalls after response headers arrive. A cancelled operation does not replace the last successful panel result. Body cleanup for discarded redirects and unsupported content is best effort so the original protocol/content error remains visible.

## Install

```sh
npm install --save-exact @pi-harness/plugin-browser-fetch
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: browser-fetch
  name: "@pi-harness/plugin-browser-fetch"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
