# @pi-harness/plugin-session-bridge

Session Bridge — Preview and export handoffs, then require confirmed import of a strictly validated, bounded package into the active LLM context with duplicate protection.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-bridge
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-bridge
  name: "@pi-harness/plugin-session-bridge"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
