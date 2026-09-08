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

Tree scans use Workspace Navigator's bounded traversal at depth 2 with at most 80 nodes and a five-second cache. Git status is refreshed for each new scan; complete change counts survive the 12-entry sidebar preview. Returned tool and panel snapshots are detached.

Session replacement observed by a new read and plugin disposal abort the scoped shared filesystem/Git work. Cancelling an individual tool call rejects its result after the shared scan settles; it does not cancel another concurrent panel reader's scan. Workspace reads do not modify files or the Git index.
