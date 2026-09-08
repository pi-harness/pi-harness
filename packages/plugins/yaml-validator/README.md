# @pi-harness/plugin-yaml-validator

YAML Validator — Validate workspace-contained UTF-8 multi-document YAML through bounded, cancellable reads and line-aware diagnostics.

## Install

```sh
npm install --save-exact @pi-harness/plugin-yaml-validator
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: yaml-validator
  name: "@pi-harness/plugin-yaml-validator"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Validation contract

`yaml_validate({ path })` reads a regular file inside the current native Pi session workspace, validates UTF-8 YAML, and returns syntax errors and warnings with line and column positions. Switching the session, manager, session identity, or workspace clears the panel; an operation started in an old workspace cannot publish into the new one. Caller cancellation and plugin disposal prevent late results.

Aliases must refer to an anchor already encountered in the same document. Recursive aliases are allowed, and references are never expanded into JavaScript objects. Unknown custom tags may produce warnings without making the document invalid. This is syntax and alias validation; it does not validate application schemas or instantiate custom tags. `rootType` describes only the first document.

Files are limited to 512 KiB, paths to 4,096 characters, and streams to 100 documents. The document limit is checked after parsing the bounded input. Diagnostics retain full error and warning counts, with at most 1,000 entries in tool details, 50 combined entries in model text and panel data, and 20 in the rendered panel. Errors take priority over warnings. Individual diagnostic messages are limited to 2,000 characters; omitted entries are reported explicitly.

The tool accepts only the documented `path` property. Invalid UTF-8, oversized files, non-regular files, and paths resolving outside the current workspace fail. File contents are not modified or uploaded. Parsing runs synchronously on the bounded input; cancellation checks do not impose a hard CPU deadline on the parser.
