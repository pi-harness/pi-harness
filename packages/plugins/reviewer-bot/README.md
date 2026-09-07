# @pi-harness/plugin-reviewer-bot

Reviewer Bot — Review the current Git diff for risky changes, unfinished markers, and large files without modifying the workspace.

## Install

```sh
npm install --save-exact @pi-harness/plugin-reviewer-bot
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: reviewer-bot
  name: "@pi-harness/plugin-reviewer-bot"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
