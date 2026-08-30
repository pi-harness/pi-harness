# Cordis Pi Harness Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a complete plugin-first Pi Harness CLI on the published DeepSeek Cordis stack and the stable Pi coding-agent SDK.

**Architecture:** A thin launcher boots a YAML Cordis tree. All Pi capabilities and application surfaces are typed Cordis services/plugins; Cordis owns loading, dependency injection, fibers, effects, grouping, configuration, and optional HMR.

**Tech Stack:** Node.js 22, TypeScript ESM, npm workspaces, `@deepseek-ai/cordis` and its loader/include/group/timer/hmr/logger plugins, `@earendil-works/pi-coding-agent`, TypeBox/Standard Schema, Vitest, ESLint.

---

### Task 1: Workspace and package boundaries

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.gitignore`, `README.md`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/cli/package.json`, `packages/cli/tsconfig.json`

**Steps:**
1. Add exact runtime dependency versions approved in the design and exact development tool versions.
2. Configure npm workspaces, Node 22 engines, ESM, strict TypeScript, build/check/test scripts, and workspace package exports.
3. Install with lifecycle scripts disabled and verify the lockfile resolves one DeepSeek Cordis family.
4. Commit the workspace baseline.

### Task 2: Cordis boot contract

**Files:**
- Create: `packages/core/test/boot.test.ts`, `packages/core/test/fixtures/plugins.ts`
- Create: `packages/core/src/boot.ts`, `packages/core/src/context.ts`, `packages/core/src/index.ts`

**Steps:**
1. Write failing tests proving a YAML profile activates a fixture plugin, missing plugins fail loudly, unresolved injections fail startup, and partial activation is disposed.
2. Run the focused Vitest file and confirm failures are caused by the absent boot API.
3. Implement `bootHarness()` with a root `Context`, Loader, Include/Group built-ins, loader settlement, activation audit, and rollback disposal.
4. Re-run the focused test until green, then run typecheck.
5. Commit the boot contract.

### Task 3: Profile and launcher contract

**Files:**
- Create: `packages/core/test/profile.test.ts`, `packages/cli/test/args.test.ts`
- Create: `packages/core/src/profile.ts`, `packages/cli/src/args.ts`

**Steps:**
1. Write failing tests for built-in profile resolution, explicit config paths, path traversal rejection, launcher-only arguments, inner application arguments, and diagnostic formatting.
2. Verify the tests fail for missing implementations.
3. Implement deterministic profile resolution and CLI parsing without importing plugin code.
4. Re-run tests and typecheck.
5. Commit profile and argument handling.

### Task 4: Pi domain services and models/resources/session/tools plugins

**Files:**
- Create: `packages/core/test/services.test.ts`
- Create: `packages/core/src/services.ts`, `packages/core/src/plugins/models.ts`, `packages/core/src/plugins/resources.ts`, `packages/core/src/plugins/session.ts`, `packages/core/src/plugins/tools.ts`

**Steps:**
1. Write failing tests for service activation order, model selection errors, in-memory versus JSONL session selection, and core tool contribution.
2. Verify red tests against real Cordis contexts and real Pi service objects; use a deterministic provider only at the network boundary.
3. Implement typed Cordis context augmentation and plugin configuration schemas.
4. Register cleanup through `ctx.effect()` and prohibit silent fallback.
5. Re-run focused tests and typecheck, then commit.

### Task 5: Pi runtime plugin

**Files:**
- Create: `packages/core/test/runtime.test.ts`
- Create: `packages/core/src/plugins/runtime.ts`, `packages/core/src/runtime.ts`

**Steps:**
1. Write a failing integration test that mounts models/resources/session/tools/runtime plugins and completes one deterministic agent response.
2. Confirm the failure is the missing runtime service.
3. Implement session creation, event forwarding, abort, and idempotent disposal using the public Pi SDK.
4. Verify the focused integration test and all core tests.
5. Commit the runtime plugin.

### Task 6: Stdio application and CLI lifecycle

**Files:**
- Create: `packages/core/test/stdio.test.ts`, `packages/cli/test/cli.test.ts`
- Create: `packages/core/src/plugins/stdio.ts`, `packages/core/src/stdio.ts`, `packages/cli/src/main.ts`, `packages/cli/src/bin.ts`

**Steps:**
1. Write failing tests for prompt input, text-delta output, nonzero failures, SIGINT abort, and bounded reverse-order shutdown.
2. Verify failures are caused by missing surface and launcher behavior.
3. Implement stdio as a Cordis plugin and the launcher as boot/signal glue only.
4. Re-run focused tests and CLI subprocess tests.
5. Commit the application surface.

### Task 7: Built-in profiles, HMR, and example plugin

**Files:**
- Create: `profiles/default/cordis.yml`, `profiles/development/cordis.yml`, `examples/plugin-hello/package.json`, `examples/plugin-hello/src/index.ts`
- Create: `packages/core/test/profiles.integration.test.ts`

**Steps:**
1. Write failing tests that load the packaged default profile and prove the development profile mounts logger, timer, and HMR while the default profile does not mount HMR.
2. Add explicit YAML rows with stable ids and an example external plugin using Cordis injection/effects.
3. Verify both profiles activate and dispose without leaked watchers or handles.
4. Commit profiles and example.

### Task 8: Documentation, packaging, and full verification

**Files:**
- Modify: `README.md`
- Create: `.github/workflows/ci.yml`

**Steps:**
1. Document installation, profiles, plugin authoring, security boundary, configuration, and deterministic smoke commands.
2. Add CI on the repository's self-hosted runner convention when repository-specific runner metadata is available; otherwise avoid committing an unusable workflow and record the missing remote metadata.
3. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and installed-package CLI smoke tests with full exit-code visibility.
4. Review the complete diff for generated markers, machine-specific paths, secrets, dependency drift, and missing exports.
5. Commit all remaining files, push/open a PR when a remote exists, and publish the self-contained EveryAPI verification artifact.
