# @pi-harness/plugin-browser-fetch

Browser Fetch — Fetch public HTTP and HTTPS pages as bounded text with descriptor-safe inputs, DNS pinning, per-redirect private-network validation, textual MIME enforcement, cancellation, a whole-request timeout, and validated fail-closed panel reporting.

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
