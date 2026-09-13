# @pi-harness/plugin-reverse-skill

Reverse Skill Firewall — Inspect untrusted Skill text and return permitted content inside an explicit untrusted-data wrapper.

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

## Behavior and limits

`skill_inject` applies Skill Guard's heuristic rules to at most 128 KiB of UTF-8 text. The tool requires a non-empty name of at most 64 characters. `safe` means no rule matched, not proven safe. `review` content is withheld unless `allowReview` is true; an explicit false overrides the configured default. `blocked` content is always withheld, including when review content is allowed.

The returned wrapper is a textual trust reminder, not an execution sandbox or a guarantee against prompt injection. This tool does not load files, install or activate a Skill, modify system instructions, or intercept other Skill-loading paths. The caller has already supplied the original source as tool input; withholding output does not remove it from earlier conversation history or logs. Rule findings contain summaries, while panel state excludes source content.

Calls cancelled before inspection or retained after disposal reject without publishing a new result. Tool details and panel snapshots are detached copies; invalid parameters and failed registration do not leave active tool state behind.
