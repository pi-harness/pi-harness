# @pi-harness/plugin-reverse-skill

Reverse Skill Firewall — Inspect untrusted Skill text and inject it only through an explicit bounded data boundary.

## Install

```sh
npm install --save-exact @pi-harness/plugin-reverse-skill
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: reverse-skill
  name: "@pi-harness/plugin-reverse-skill"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
