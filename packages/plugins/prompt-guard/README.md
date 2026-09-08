# @pi-harness/plugin-prompt-guard

Prompt Guard — Detect prompt override, secret exfiltration, remote payloads, and hidden-instruction indicators without retaining input text.

## Install

```sh
npm install --save-exact @pi-harness/plugin-prompt-guard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: prompt-guard
  name: "@pi-harness/plugin-prompt-guard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Behavior and limits

This is a passive heuristic audit, not an execution gate. It listens to user and tool-result `message_start` events and exposes `prompt_guard_scan`. It neither removes content nor blocks model/tool execution. The `blocked` risk value denotes a high-risk report, not a blocked action. English regular expressions can produce false positives and miss obfuscated, non-English, or otherwise unmatched attacks. Quoted documentation can trigger the same rules.

On-demand scans reject inputs above 128 KiB. Oversized user messages are reported for review without a scan. Tool results scan only the first 128 KiB at a UTF-8 boundary; reports include `scannedBytes`, `scannedChars` (UTF-16 code units), `truncated`, and an `input_truncated` finding. Unscanned content never receives a safe verdict.

The panel retains only structured findings and caller-supplied source labels, not scanned input text. It highlights the highest risk in the current session and clears state on session changes. Cancelled or disposed tool calls do not publish results.
