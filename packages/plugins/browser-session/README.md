# @pi-harness/plugin-browser-session

Browser Session — Control a loopback-only Chrome DevTools session with descriptor-safe commands, bounded discovery, cancellable operations, screenshot metadata protection, and validated fail-closed panel previews.

## Install

```sh
npm install --save-exact @pi-harness/plugin-browser-session
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: browser-session
  name: "@pi-harness/plugin-browser-session"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
