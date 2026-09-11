# @pi-harness/plugin-prompt-library

Prompt Library — Save, search, update, and delete reusable prompt templates in the current Pi session.

## Install

```sh
npm install --save-exact @pi-harness/plugin-prompt-library
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: prompt-library
  name: "@pi-harness/plugin-prompt-library"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Template operations

Call `prompt_library` with `action: "save"` to create a template using `title`, `prompt`, and optional `tags`. Supplying `id` updates an existing template and preserves omitted fields; an unknown ID is an error. `action: "list"` optionally filters with `query` and returns compact IDs/titles to the model. Use `action: "get"` with an existing `id` to retrieve that template's full text in model-visible content; this read does not modify the journal or return unrelated templates. `action: "delete"` requires an existing `id`. Fields unrelated to the chosen action are rejected. This plugin stores text; it does not expand placeholders, execute templates, or register SDK slash commands.

The library belongs to the current session journal. Reopening the saved session restores templates; switching sessions changes the panel immediately. Once the native runtime is active, its current manager is authoritative even when the launch service still points to the original manager. Queued writes capture the current manager and session header and reject replacement before execution. Limits are 100 templates, 120 title characters, 8000 prompt characters, ten tags of 40 characters each, and 120 query characters. Adding at capacity fails without evicting earlier entries. Invalid journal entries fail visibly rather than being silently dropped.

Writes use the SDK SessionManager. Before the first assistant message, a new session may remain in memory according to SDK persistence behavior. If an append throws, the manager may already contain an unpersisted entry; the library therefore refuses further reads and writes for that manager and requires reopening the session from disk. It cannot roll back an SDK or filesystem partial write. Cancelled or disposed calls fail before mutation, and returned snapshots do not share mutable journal objects.
