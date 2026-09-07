# @pi-harness/plugin-skill-catalog

Skills Catalog — List loaded Agent Skills and safely inspect one through a bounded untrusted-data boundary, plus managed MCP status.

## Install

```sh
npm install --save-exact @pi-harness/plugin-skill-catalog
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: skill-catalog
  name: "@pi-harness/plugin-skill-catalog"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
