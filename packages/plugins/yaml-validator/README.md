# @pi-harness/plugin-yaml-validator

YAML Validator — Validate workspace-contained UTF-8 multi-document YAML through bounded, cancellable reads and line-aware diagnostics.

## Install

```sh
npm install --save-exact @pi-harness/plugin-yaml-validator
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: yaml-validator
  name: "@pi-harness/plugin-yaml-validator"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
