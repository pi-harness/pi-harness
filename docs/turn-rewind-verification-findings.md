# Turn Rewind verification correction

Observed on the source service at port 3144 after the real browser run recorded at 2026-09-09 17:00:14 UTC:

- `turn-rewind-panel.data.latest.status` is `completed`, with matching target text and editor text.
- The current branch has four messages (the alpha and beta turns).
- The native session retains ten entries, including exactly one `session_rewind` tool call with `{ "turns": 1 }` and a queued tool result.
- Navigation removed the request/tool messages from the active branch, not from retained history.

The verifier's `messages()[before:]` assumption is invalid for a branch-changing operation. Waiting for the current branch to grow cannot fix this. Verification must correlate the new tool call and result in retained entries, then check the final panel state and active branch separately.

Earlier claims that the tool was missing from the registry or that the session API was failing to synchronize were unsupported and are withdrawn. The prompt endpoint awaits `runtime.prompt`; it is not merely an enqueue acknowledgement.

This is evidence of one successful native navigation, not full plugin acceptance. The removed idle guard still needs causal verification; a passing test rewritten to omit its previous safety assertion does not establish that removal was necessary or safe. Remaining verification includes editor UI restoration, preserved-branch accessibility, cancellation, and overlapping runs.
