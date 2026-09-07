# @pi-harness/plugin-code2skill

Code2Skill — Package selected workspace source files into a bounded local Pi skill with a generated SKILL.md manifest and preserved references.

## Install

```sh
npm install --save-exact @pi-harness/plugin-code2skill
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: code2skill
  name: "@pi-harness/plugin-code2skill"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
