# @pi-harness/plugin-telemetry-blocker

Telemetry Blocker — Block configured outbound telemetry destinations and report blocked attempts without collecting payload contents.

## Install

```sh
npm install --save-exact @pi-harness/plugin-telemetry-blocker
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: telemetry-blocker
  name: "@pi-harness/plugin-telemetry-blocker"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
