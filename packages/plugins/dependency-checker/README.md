# @pi-harness/plugin-dependency-checker

Dependency Checker — Run a bounded, offline, read-only check of workspace package.json and requirements*.txt manifests for local package presence, duplicate declaration consistency, unresolved constraints, and unsupported Python directives.

## Install

```sh
npm install --save-exact @pi-harness/plugin-dependency-checker
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: dependency-checker
  name: "@pi-harness/plugin-dependency-checker"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
