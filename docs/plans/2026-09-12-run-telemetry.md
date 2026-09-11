# Run Telemetry Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make an active Pi Harness run visibly distinguish live model activity, model silence, SSE reconnection, and an unreachable runtime, including after a page reload.

**Architecture:** The API gateway derives a small provider-independent activity snapshot from AgentSession events and publishes it through `/api/status`. The client reports EventSource lifecycle separately, combines server and transport facts in a pure view-model helper, and renders one accessible telemetry rail in the existing header and streaming turn.

**Tech Stack:** TypeScript, React, Node HTTP Server-Sent Events, Vitest, Vite, CSS, Python Playwright.

---

### Task 1: Publish current run activity

**Files:**

- Modify: `packages/api-gateway/src/index.ts`
- Test: `packages/api-gateway/test/index.test.ts`

**Steps:**

1. Add a failing gateway test whose fake session emits `agent_start`, `turn_start`, thinking/text deltas, and tool events; assert `/api/status` exposes stable ISO `startedAt`, updated `lastActivityAt`, and the correct phase only while `isStreaming` is true.
2. Run the targeted test and confirm it fails because `run` is absent.
3. Add a bounded `RunActivity` tracker beside the retained event buffer. Start it on `agent_start` or `turn_start`, update it for meaningful runtime events, clear it on session replacement, and make `createStatus` omit it when the session is idle.
4. Rerun the gateway test and surrounding API tests.

### Task 2: Surface EventSource lifecycle

**Files:**

- Modify: `packages/client-web/src/control-room.ts`
- Test: `packages/client-web/test/react-room.test.ts`

**Steps:**

1. Add a failing test with a minimal fake `EventSource`; assert the client reports `connecting`, `open`, `reconnecting`, and `closed`, while preserving parsed message delivery and cleanup.
2. Run the test and confirm the lifecycle callback is missing.
3. Extend `ClientApi.subscribeEvents` with an optional connection callback and implement it with `onopen`, `onerror`, and `readyState`.
4. Extend `subscribeRuntimeEvents` to forward events and connection state through stable refs, then rerun the test.

### Task 3: Derive and render honest run state

**Files:**

- Modify: `packages/client-web/src/control-room.ts`
- Modify: `packages/client-web/src/react-room.tsx`
- Test: `packages/client-web/test/react-room.test.ts`

**Steps:**

1. Add failing pure-function tests covering live thinking, live response, tool activity, 30-second silence, SSE reconnection, combined status/SSE failure, and page reload during a run.
2. Implement a pure `runTelemetryView` helper that clamps invalid timestamps, formats elapsed/activity seconds, and follows the design priority without claiming provider progress.
3. Initialize the streaming placeholder from server run facts whenever status becomes running, but do not erase already streamed text. Update local activity on every relevant SSE event.
4. Replace the generic header label with phase, elapsed clock, and optional activity/connection detail. Keep Stop visible and announce only meaningful state changes.
5. Rerun client tests.

### Task 4: Style and localize the telemetry rail

**Files:**

- Modify: `apps/web/src/style.css`
- Modify: `packages/client-web/src/locales/en.json`
- Modify: `packages/client-web/src/locales/zh-TW.json`
- Modify: `packages/client-web/src/locales/ja.json`
- Modify: `packages/client-web/src/locales/ko.json`
- Modify: `packages/client-web/src/locales/es.json`
- Modify: `packages/client-web/src/locales/fr.json`
- Modify: `packages/client-web/src/locales/de.json`
- Modify: `packages/client-web/src/locales/pt-BR.json`
- Modify: `packages/client-web/src/locales/ru.json`
- Test: `packages/client-web/test/i18n.test.ts`
- Test: `packages/client-web/test/react-room.test.ts`

**Steps:**

1. Add the new source keys to every catalog and run i18n coverage before styling.
2. Style the rail with existing tokens, monospaced clocks, explicit warning/reconnect/offline variants, narrow-width wrapping, focus visibility, and reduced-motion behavior.
3. Add CSS contract assertions that Stop remains reachable and text is not hidden on narrow screens.
4. Run i18n, React, client build/typecheck, and web build.

### Task 5: Exercise the real page under controlled run conditions

**Files:**

- Create: `scripts/verify-run-telemetry.py`
- Modify: `docs/production-readiness.md`

**Steps:**

1. Start the source-built console against a controlled local API/SSE fixture and open it in headless Chromium at desktop and narrow widths.
2. Reproduce the baseline by opening during an already-running request; assert phase/clock/Stop render without a new `turn_start`.
3. Emit thinking, text, tool, quiet, disconnect/reconnect, and finish transitions; assert exact accessible text, no horizontal overflow, and no page/console errors.
4. Save and inspect screenshots, then remove only owned temporary profiles, fixtures, screenshots, and servers.
5. Record exact evidence and remaining authenticated-provider follow-ups in the production-readiness ledger.

### Task 6: Final verification and integration

**Files:**

- Review all files changed above.

**Steps:**

1. Run scoped ESLint, format check, API/client tests, client typecheck/build, and web build.
2. Run `npm run build`, `npx vitest run --maxWorkers=2`, and `git diff --check`.
3. Review the complete diff and fix all Critical/Important findings.
4. Commit with Conventional Commits, push, open an English pull request, and follow the user's standing instruction to merge normally without `--admin` or waiting for CI.
