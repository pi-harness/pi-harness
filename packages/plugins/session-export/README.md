# @pi-harness/plugin-session-export

Session Export — Export the current Pi conversation to a bounded Markdown file inside the workspace without changing session history.

## Install

```sh
npm install --save-exact @pi-harness/plugin-session-export
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: session-export
  name: "@pi-harness/plugin-session-export"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
