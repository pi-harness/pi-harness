# @pi-harness/plugin-anchored-standard

Anchored Standard — Audit agent trajectories against an explicit tool-call allowlist and flag activity outside the anchored run.

## Install

```sh
npm install --save-exact @pi-harness/plugin-anchored-standard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: anchored-standard
  name: "@pi-harness/plugin-anchored-standard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Audit semantics

`trajectory_anchor_check {}` returns a complete JSON report in both model-visible text and UI details: status, `auditOnly: true`, `scope: "since-plugin-load"`, event count, tool-call count, configured budget, allowed tools, and violation codes/messages.

- This is a read-only audit, **not enforcement**: disallowed tools and over-budget calls still execute.
- Events and violations accumulate across sessions for the plugin's lifetime. Only the first finding of each of the five violation codes is retained. Reloading the plugin clears this history.
- `toolCalls` counts the current or last run and resets on `agent_start`; a historical `violated` status does not mean the current run introduced another violation.
- `maxToolCalls` defaults to 64 (bounded to 1–512); an empty `allowedTools` list allows any tool. The allowlist contains at most 512 names of 128 UTF-16 code units each.
- Diagnostic tool names are clipped to 128 code units with an ellipsis; allowlist matching uses the full original name. The complete serialized UTF-8 report stays within 512 KiB, including worst-case JSON escaping.
