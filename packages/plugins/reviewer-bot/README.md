# @pi-harness/plugin-reviewer-bot

Reviewer Bot — Review tracked Git changes against HEAD for whitespace, likely credentials, and TODO/FIXME markers without executing diff helpers.

## Install

```sh
npm install --save-exact @pi-harness/plugin-reviewer-bot
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: reviewer-bot
  name: "@pi-harness/plugin-reviewer-bot"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Scope and limits

`review_changes` reads staged and unstaged tracked changes against HEAD. It requires an existing commit and excludes untracked files. This is a heuristic whitespace, credential-pattern and TODO/FIXME check, not semantic code review, test execution or a large-file detector. A pass means no configured check matched. Binary content is not inspected. Repository textconv and external diff commands are disabled. Git path prefixes and color are fixed for parsing.

The default diff buffer is 1 MiB (16 KiB–8 MiB configurable), and each Git command has a 15-second timeout (100 ms–60 seconds configurable). Exceeding the buffer fails rather than accepting a partial diff. Reports retain at most 512 files and 100 findings, with full counts and explicit truncation flags. Whitespace reports omit raw source lines. Snapshots are detached, and cancellation or disposal terminates outstanding Git commands and prevents publication; failed calls preserve the previous successful report. Separate Git reads are not an atomic working-tree snapshot: avoid editing files during a review.
