# @pi-harness/plugin-at-file

@file Context — Attach a bounded 256 KiB strict UTF-8 workspace file using canonical workspace path confinement and no-follow regular-file reads, framing it as offline, read-only, untrusted model context with closing-tag neutralization and cancellable sequential execution.

## Install

```sh
npm install --save-exact @pi-harness/plugin-at-file
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: at-file
  name: "@pi-harness/plugin-at-file"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
