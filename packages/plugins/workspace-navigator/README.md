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

`workspace_tree` reads the active native Pi session manager's working directory, falling back to the launch directory only when no native runtime exists. Its optional raw `path` is bounded to 512 characters before trimming, rejects NUL and backslash characters, and must resolve to a directory inside that workspace. Outside paths and paths explicitly targeting an ignored directory are rejected. Results use POSIX-style paths relative to the requested directory, while preserving a literal backslash in a POSIX filename. `maxDepth` defaults to 4 and is clamped to 1–8; `maxNodes` defaults to 200 and is clamped to 1–500. Nonfinite values, unknown tool parameters, accessors and non-plain parameter objects are rejected; validated descriptor values are snapshotted before use.

Directory discovery uses a global budget of 4,096 entries, including ignored directories and symlinks. Discovery is streamed with byte-preserving directory names rather than loading arbitrarily large directories. Names that are not valid UTF-8 are omitted and mark the report incomplete instead of being exposed as replacement-character paths. Reaching a node, depth, discovery or serialization limit, or an unreadable subdirectory, marks the result truncated; hitting the exact discovery budget conservatively marks it incomplete. Nodes discovered within the budget are sorted by raw name bytes per directory. Missing or unreadable roots fail. Directory type and workspace containment are rechecked from filesystem metadata before recursion, including at the depth boundary, so unknown directory-entry types and directory-to-symlink races do not bypass exclusions. Symlinks are skipped and `.git`, `node_modules`, `.pi`, `dist`, and `build` directories are excluded, using case-insensitive directory-name matching on Windows and macOS. Counts describe collected nodes, not the total workspace inventory.

`workspace_status` runs read-only Git status limited to the active workspace. When that workspace is a subdirectory of a parent repository, changes outside it are excluded and returned paths are relative to the active workspace. NUL-delimited porcelain output preserves valid UTF-8, newlines and rename source/destination pairs; undecodable paths are omitted and mark the report truncated rather than creating ambiguous replacement-character paths. It collects at most 500 entries with `changedCount` and `truncated`, within a 4 MiB process-output limit. Branch, repository prefix and status are separate commands and do not form an atomic snapshot. Optional index writes and filesystem-monitor hooks are disabled. `gitTimeoutMs` defaults to 10,000 and is clamped to 100–60,000. An unavailable report includes a bounded reason: non-repository, timeout, missing Git, output limit, invalid output or another Git error. It never claims an unavailable repository is clean.

Both tools cap their complete JSON evidence at 128 KiB in model-visible text and detached details. Entries are removed from the end when needed to honor that limit, while count and truncation metadata preserve the incomplete state. Caller cancellation and plugin disposal propagate to the operation; results from an obsolete native session are rejected. Changing the native session object, manager, session ID or working directory clears cached tree and Git data. Directory reads check cancellation between filesystem operations; an individual filesystem request is not forcibly interrupted. The filesystem can change concurrently, so these reports are observations rather than transactional snapshots.

The panel validates detached snapshots and producer invariants before rendering, including node depth, parent-directory order and scan counts. It displays the active workspace, the complete bounded tree and Git inventories, scan limits, counts, truncation notices and actionable localized Git failure reasons. Long paths wrap without visual clipping; each inventory has a keyboard-focusable bounded scroll area and visible focus outline. Tree rows expose localized file/directory labels and hierarchy levels to assistive technology. Git status appears independently of the tree. A failed operation retains the last completed report in the same session. Partial plugin activation is rolled back if later registrations fail. The plugin does not modify project files, install dependencies or call a model.
