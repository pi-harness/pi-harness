# @pi-harness/plugin-workspace-navigator

Workspace Navigator — Show a bounded workspace tree and read-only Git status for a high-signal coding sidebar.

## Install

```sh
npm install --save-exact @pi-harness/plugin-workspace-navigator
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: workspace-navigator
  name: "@pi-harness/plugin-workspace-navigator"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Behavior and limits

`workspace_tree` reads the active native Pi session manager's working directory, falling back to the launch directory only when no native runtime exists. Its optional `path` is resolved inside that workspace; outside paths are rejected. Results are relative to the requested directory. `maxDepth` defaults to 4 and is clamped to 1–8; `maxNodes` defaults to 200 and is clamped to 1–500. Nonfinite values and unknown tool parameters are rejected.

Directory discovery uses a global budget of 4,096 entries, including ignored directories and symlinks. Discovery is streamed rather than loading arbitrarily large directories. Reaching a node, depth or discovery limit, or an unreadable subdirectory, marks the result truncated; hitting the exact discovery budget conservatively marks it incomplete. Nodes discovered within the budget are sorted by name per directory. Missing or unreadable roots fail. Symlinks are skipped and `.git`, `node_modules`, `.pi`, `dist`, and `build` directories are excluded. Counts describe collected nodes, not the total workspace inventory.

`workspace_status` runs read-only Git status in the active workspace. NUL-delimited porcelain output preserves Unicode, newlines and rename source/destination pairs. It returns at most 500 entries with `changedCount` and `truncated`, within a 4 MiB process-output limit. Paths are relative to the containing Git repository root, even when the workspace is a subdirectory. Branch and status are separate commands and do not form an atomic snapshot. Optional index writes and filesystem-monitor hooks are disabled. `gitTimeoutMs` defaults to 10,000 and is clamped to 100–60,000; timeout, missing Git, output overflow or a non-repository produces `available: false`, not a claim that the repository is clean.

Both tools return bounded JSON evidence in model-visible text and detached details. Caller cancellation and plugin disposal propagate to the operation; results from an obsolete native session are rejected. Changing the native session object, manager, session ID or working directory clears cached tree and Git data. Directory reads check cancellation between filesystem operations; an individual filesystem request is not forcibly interrupted. The filesystem can change concurrently, so these reports are observations rather than transactional snapshots.

The panel displays the active workspace, up to 36 collected tree nodes and up to 12 Git entries, with truncation notices. Git status appears independently of the tree. A failed operation retains the last completed report in the same session. Partial plugin activation is rolled back if later registrations fail. The plugin does not modify project files, install dependencies or call a model.
