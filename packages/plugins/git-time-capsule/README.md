# @pi-harness/plugin-git-time-capsule

Git Time Capsule — Capture the current unstaged tracked Git diff as a byte-exact, validated undo capsule without external diff or textconv helpers, then reverse-apply it only after explicit confirmation.

## Install

```sh
npm install --save-exact @pi-harness/plugin-git-time-capsule
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: git-time-capsule
  name: "@pi-harness/plugin-git-time-capsule"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
