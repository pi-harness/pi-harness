# @pi-harness/plugin-annotation

Annotations — Capture bounded selections and notes from the conversation for later agent context.

`annotation_manage` supports add/list/remove/clear/prompt. List returns model-visible JSON with complete quotes and notes, IDs, count, returned and nextOffset. It defaults to 10 entries and never exceeds 64 KiB of UTF-8 JSON; follow nextOffset using offset to read the rest. Optional limit is 1–50. Existing details retain the full collection for rendering; quotes/notes are not silently shortened to fit a page.

The collection is in-memory for the plugin instance (up to 50 annotations), not persisted per session. `prompt` generates a snapshot without changing original conversation messages; “recently generated context” remains that historical snapshot until another prompt or clear. Cancelled and disposed tool invocations cannot mutate the collection.

## Install

```sh
npm install --save-exact @pi-harness/plugin-annotation
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: annotation
  name: "@pi-harness/plugin-annotation"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
