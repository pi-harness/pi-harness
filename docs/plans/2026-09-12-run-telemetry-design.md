# Run telemetry design

## Problem

Pi Harness currently starts its elapsed timer only after the current browser receives a `turn_start` event. Reloading or opening the console during an active run therefore removes the streaming placeholder, elapsed time, slow-response warning, and contextual Stop control even though `/api/status` still says `running`. The EventSource client ignores `open` and `error`, so a healthy but quiet model and a disconnected live stream look identical. A stale successful status snapshot can also keep saying `running` while later status requests fail.

## Chosen design

Use one compact flight-recorder-style run strip rather than a new monitoring page. The gateway owns provider-independent run facts: `startedAt`, `lastActivityAt`, and a bounded phase (`starting`, `thinking`, `responding`, or `tool`). It updates them from AgentSession events and includes them in `/api/status` only while the native session reports `isStreaming`. The browser owns transport facts through EventSource lifecycle callbacks (`connecting`, `open`, `reconnecting`, `closed`) and records whether the latest status poll succeeded.

The display priority is service unreachable, live updates reconnecting, model temporarily quiet, then the current activity phase. Every running state shows total elapsed time and keeps Stop reachable. Thirty seconds without an AgentSession event produces a neutral quiet notice; five minutes produces the existing stronger slow-response warning. This does not claim the provider is stuck and does not invent progress percentages. A page opened mid-run reconstructs its clock and phase from `/api/status`; subsequent SSE deltas update the local activity immediately.

The visual signature is a restrained telemetry rail: the existing run dot, a plain-language phase, a monospaced elapsed clock, and an activity-age segment. Color reinforces but never replaces text. The rail wraps on narrow screens, preserves the Stop button, respects reduced motion, and uses the console's existing palette and typography.

## Alternatives rejected

- Only restore the timer after reload: smaller, but transport loss and model silence remain indistinguishable.
- Add a full event timeline to the chat header: comprehensive, but duplicates the trajectory view and adds noise to the primary workspace.

## Evidence and constraints

The HTML EventSource specification defines `CONNECTING`, `OPEN`, and `CLOSED`, fires `error` while reconnecting, and reconnects automatically. The Vercel AI SDK separately models submitted, streaming, ready, error, abort, and disconnect states. Pi's AgentSession emits lifecycle, message delta, and tool events, so the gateway can report observed activity without inspecting provider internals. No dependency or protocol replacement is required.

## Acceptance

- A fresh page opened during a run shows phase, elapsed time, last activity, and Stop without waiting for another `turn_start`.
- Live thinking/text/tool events update phase and activity time.
- Quiet, reconnecting, and service-unreachable states use different text and accessible status semantics.
- Finishing or aborting removes transient run telemetry.
- Existing session, prompt, navigation, streaming, responsive, and localization behavior remains intact.
