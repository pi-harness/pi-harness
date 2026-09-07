# @pi-harness/plugin-web-research

Web Research — Search the public web through a configurable provider and return bounded, cited source evidence.

## Install

```sh
npm install --save-exact @pi-harness/plugin-web-research
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: web-research
  name: "@pi-harness/plugin-web-research"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
