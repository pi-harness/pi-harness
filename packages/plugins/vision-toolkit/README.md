# @pi-harness/plugin-vision-toolkit

Vision Toolkit — Catalog signature-verified PNG, JPEG, GIF, and WebP metadata with bounded header reads, cancellable workspace traversal, explicit partial results, and a local-only normalized panel.

## Install

```sh
npm install --save-exact @pi-harness/plugin-vision-toolkit
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: vision-toolkit
  name: "@pi-harness/plugin-vision-toolkit"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
