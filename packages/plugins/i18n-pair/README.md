# @pi-harness/plugin-i18n-pair

I18n Pair — Strict read-only comparison of bounded JSON locale files from no-follow workspace paths, with collision-safe missing and extra keys, stable failures, cancellation, and validated panel status.

## Install

```sh
npm install --save-exact @pi-harness/plugin-i18n-pair
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: i18n-pair
  name: "@pi-harness/plugin-i18n-pair"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native workspace and key diagnostics

`i18n_check` compares files in the current native session workspace, using the launch directory before a native session is available. Replacing the session, changing its ID, or changing its workspace clears the report and resets panel status to idle. Pending results and errors from the previous scope cannot update the new session panel. Caller cancellation and disposal discard pending results; files are never rewritten.

The model receives JSON with concrete missing and extra keys, both total counts, and `truncated`. Up to 20 keys per side are included within a shared 32 KiB UTF-8 budget, alternating sides so both can contribute. Individual keys are never shortened. Tool details retain the complete bounded comparison; the panel retains its separate 100-key-per-side limit.
