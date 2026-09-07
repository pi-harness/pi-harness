# @pi-harness/plugin-history-compressor

History Compressor — Compact the current Pi session automatically when context usage approaches a configured threshold.

## Install

```sh
npm install --save-exact @pi-harness/plugin-history-compressor
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: history-compressor
  name: "@pi-harness/plugin-history-compressor"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
