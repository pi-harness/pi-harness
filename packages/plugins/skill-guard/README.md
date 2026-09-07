# @pi-harness/plugin-skill-guard

Skill Guard — Audit each loaded Skill entry Markdown file with bounded heuristics for instruction override, secret exfiltration, destructive commands, and obfuscation; it reports risk labels and does not disable loaded Skills.

## Install

```sh
npm install --save-exact @pi-harness/plugin-skill-guard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: skill-guard
  name: "@pi-harness/plugin-skill-guard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
