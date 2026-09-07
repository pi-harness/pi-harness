# @pi-harness/plugin-genui

GenUI — Render bounded structured cards with text, badge, and decimal progress blocks while displaying HTML and scripts as plain text.

## Install

```sh
npm install --save-exact @pi-harness/plugin-genui
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: genui
  name: "@pi-harness/plugin-genui"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
