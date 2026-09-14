# Marketplace Plugin Dependencies Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make one marketplace install produce a complete, dependency-valid plugin configuration.

**Architecture:** Add a validated dependency graph to marketplace metadata and expose a dependency-first planner. Reuse the gateway's existing npm/profile/loader transaction while applying the whole missing plan as one unit.

**Tech Stack:** TypeScript, Cordis loader, Node.js process/filesystem APIs, JSON Schema, Vitest.

---

### Task 1: Define and validate the dependency graph

**Files:**

- Modify: `packages/api-gateway/src/marketplace.ts`
- Modify: `docs/marketplace-entry.schema.json`
- Modify: `packages/api-gateway/test/marketplace-schema.test.ts`
- Modify: `packages/api-gateway/src/marketplace-entries/official/change-verifier.json`

**Steps:**

1. Add failing schema tests that accept unique kebab-case dependency IDs and reject malformed values.
2. Add pure graph tests proving dependency-first order and rejecting unknown IDs and cycles.
3. Run `npx vitest run packages/api-gateway/test/marketplace-schema.test.ts` and confirm the new assertions fail for the missing contract.
4. Add `dependencies?: readonly string[]`, runtime validation, whole-catalog reference/cycle checks, and `marketplaceInstallPlan()`.
5. Declare `change-verifier` dependencies as `reviewer-bot` and `test-harness`; update the JSON Schema.
6. Re-run the targeted tests and confirm they pass.

### Task 2: Install a complete dependency plan atomically

**Files:**

- Modify: `packages/api-gateway/src/index.ts`
- Modify: `packages/api-gateway/test/index.test.ts`

**Steps:**

1. Add a failing endpoint test that installs Change Verifier and expects one npm invocation containing all three exact package specs, dependency-first profile rows, and dependency-first loader creation.
2. Add a failing rollback test where the final activation fails and assert every created loader entry is removed while profile, `package.json`, and `package-lock.json` return to their original bytes.
3. Add a failing leased-registry test and assert all package/profile entries remain for restart even though activation stops at the first leased tool plugin.
4. Run the three endpoint tests and confirm each fails for the current single-plugin implementation.
5. Expand the requested plugin with `marketplaceInstallPlan()`, filter already-installed profile or loader packages, pass all missing specs to one npm install, append every profile row, and create/remove loader entries as an ordered unit.
6. Re-run the targeted endpoint tests and existing marketplace endpoint tests.

### Task 3: Publish the contract and verify the real journey

**Files:**

- Modify: `packages/client-web/src/control-room.ts`
- Modify: `docs/plugin-marketplace.md`

**Steps:**

1. Add the optional dependency field to the client API type.
2. Document dependency validation, dependency-first installation, rollback, and restart semantics.
3. Run format, lint, workspace typecheck, package smoke, full Vitest, and `git diff --check`.
4. In an isolated `pih-local` home, uninstall the broken standalone Change Verifier fixture, install it once through the web marketplace, restart, invoke `verify_change_gate`, and confirm Reviewer Bot and Test Harness are active and the gate executes rather than reporting a missing provider tool.
5. Request independent review, fix all Critical and Important findings, then commit, open a PR, and merge according to the active user instruction.
