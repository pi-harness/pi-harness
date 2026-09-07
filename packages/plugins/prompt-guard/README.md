# @pi-harness/plugin-prompt-guard

Prompt Guard — Detect prompt override, secret exfiltration, remote payloads, and hidden-instruction indicators without retaining input text.

## Install

```sh
npm install --save-exact @pi-harness/plugin-prompt-guard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: prompt-guard
  name: "@pi-harness/plugin-prompt-guard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
