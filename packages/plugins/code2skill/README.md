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

## Current workspace and publication

`skill_pack_create` reads source files and writes `.pi/skills/<slug>` in the current native session workspace. Before a native session is available, it uses the harness launch directory. Queued work retains its initiating session identity and workspace; replacing the session, changing its ID, or changing its workspace invalidates that work and resets the panel report and generated count.

Cancellation, disposal, and session changes are checked before reading sources and before publishing the staged skill directory. Interrupted staging is removed. Filesystem operations already submitted cannot be recalled: empty parent directories or an already-published pack may remain if interruption occurs during those operations. A stale result is never published to the new session panel. Existing skill packs are preserved and are not overwritten.
