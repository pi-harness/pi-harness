# @pi-harness/plugin-prompt-library

Prompt Library — Save, search, update, and delete reusable prompt templates in the current Pi session.

## Install

```sh
npm install --save-exact @pi-harness/plugin-prompt-library
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: prompt-library
  name: "@pi-harness/plugin-prompt-library"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
