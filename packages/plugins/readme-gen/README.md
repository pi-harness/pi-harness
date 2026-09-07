# @pi-harness/plugin-readme-gen

README Gen — Generate README reports from strictly bounded manifest metadata and a descriptor-safe loader inventory with Markdown-safe rendering, plus confirmed no-clobber atomic writes, explicit overwrite confirmation, and cancellable sequential execution.

## Install

```sh
npm install --save-exact @pi-harness/plugin-readme-gen
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: readme-gen
  name: "@pi-harness/plugin-readme-gen"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
