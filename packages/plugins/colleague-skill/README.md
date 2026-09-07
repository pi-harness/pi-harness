# @pi-harness/plugin-colleague-skill

Colleague Skill — Create durable, structured handoff packets for another role without hidden agents or external message delivery.

## Install

```sh
npm install --save-exact @pi-harness/plugin-colleague-skill
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: colleague-skill
  name: "@pi-harness/plugin-colleague-skill"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
