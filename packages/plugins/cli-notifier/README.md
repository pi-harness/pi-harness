# @pi-harness/plugin-cli-notifier

CLI Notifier — Send local desktop notifications when an agent turn completes, fails, or is aborted, and when context compaction fails.

## Install

```sh
npm install --save-exact @pi-harness/plugin-cli-notifier
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: cli-notifier
  name: "@pi-harness/plugin-cli-notifier"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
