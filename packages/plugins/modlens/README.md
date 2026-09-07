# @pi-harness/plugin-modlens

ModLens Vision Bridge — Send bounded workspace images to native vision models or return schema-validated evidence from the bundled ModLens engine for text-only models.

## Install

```sh
npm install --save-exact @pi-harness/plugin-modlens
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: modlens
  name: "@pi-harness/plugin-modlens"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
