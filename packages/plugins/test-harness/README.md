# @pi-harness/plugin-test-harness

Test Harness — Run five fixed npm script names from a trusted workspace, reporting real status with a sanitized 12 KiB UTF-8-safe untrusted output tail, a bounded configurable timeout, and cancellable process-tree cleanup.

## Install

```sh
npm install --save-exact @pi-harness/plugin-test-harness
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: test-harness
  name: "@pi-harness/plugin-test-harness"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
