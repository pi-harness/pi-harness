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

## Scan behavior and scope

Activation performs an initial scan. `skill_guard_scan({ query?: string })` starts a new scan; the query matches bounded skill names (64 characters) and source prefixes (128 characters) before the 50-file limit, so a targeted skill beyond the initial 50 can be inspected. Reports include total loaded, matching and scanned counts, query and truncation. Invalid metadata is reported as review during an unfiltered scan; it cannot match a named query. The panel retains the latest completed scan, including its query, until another succeeds.

The tool returns full bounded findings to the model without skill source text. `blocked` means a high-risk rule matched; this plugin does not disable a skill, intercept its execution, or prevent model invocation. `safe` means no rule matched. Rules can miss malicious content and flag legitimate examples; they are not proof of safety. Only entry Markdown files are scanned, not linked scripts or supporting resources.

Files must be regular nonsymlink files with valid UTF-8 and at most 128 KiB. Read, encoding, size and metadata failures become review findings. Cancellation and disposal reject pending scans without replacing the prior completed results. Replacing the loader or changing selected bounded metadata, inventory size or matching count before publication rejects the scan. Reloading identical metadata alone does not invalidate a scan, and file contents are not an atomic snapshot across files; rescan after resource changes.

At most 50 matching files and six rule findings per file are returned. Panel data retains 20 reports and the UI shows eight. Existing independent risk rules and the current native plugin API are used without legacy aliases.
