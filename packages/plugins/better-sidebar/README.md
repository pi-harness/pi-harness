# @pi-harness/plugin-better-sidebar

Better Sidebar — Show a compact workspace, Git, and session overview beside the conversation without modifying files.

## Install

```sh
npm install --save-exact @pi-harness/plugin-better-sidebar
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: better-sidebar
  name: "@pi-harness/plugin-better-sidebar"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Current-session inspection

The panel and `sidebar_overview` use the active native manager's workspace and session ID. Each manager/header/workspace scope gets a separate tree cache and shared in-flight scan. Switching sessions invalidates the old scan and rejects its results, including an in-place new session. Before runtime creation, the launch manager supplies the initial scope.

Tree scans use Workspace Navigator's bounded traversal at depth 2 with at most 80 nodes and a five-second cache. Git status is refreshed for each new scan; complete change counts and bounded failure reasons survive the 12-entry data preview and eight-row rendered panel. Git failures are distinguished from a workspace that is not in a repository, and rename source/destination pairs are preserved. Repository-controlled control, format and bidirectional characters in paths are reversibly escaped before display. Model-facing text is a JSON envelope that explicitly labels Git paths as untrusted escaped data. Overview JSON is capped at 128 KiB by removing preview entries from the end and marking the report truncated. Unknown runtime tool parameters are rejected. Returned tool and panel snapshots are detached.

Session replacement observed by a new read and plugin disposal abort the scoped shared filesystem/Git work. Cancelling an individual tool call rejects its result after the shared scan settles; it does not cancel another concurrent panel reader's scan. Workspace reads do not modify files or the Git index.

The web client validates exact detached snapshots, structural invariants, escaped display text and the serialization budget before showing either Better Sidebar surface. It also requires each snapshot's session ID to match the active session wherever that context is available, preventing a failed refresh after session switching from exposing the previous workspace. Malformed or stale data is hidden from the persistent sidebar and shown as an explicit error in the plugin card. Git failure reasons are localized and actionable. Workspace, session and changed-file paths wrap without clipping; changed-file inventories use bounded keyboard-focusable scroll regions with visible focus outlines.
