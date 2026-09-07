# @pi-harness/plugin-image-compressor

Image Compressor — Create bounded image copies for model context while preserving the original file and reporting saved bytes.

## Install

```sh
npm install --save-exact @pi-harness/plugin-image-compressor
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: image-compressor
  name: "@pi-harness/plugin-image-compressor"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
