# Marketplace Plugin Dependencies Design

## Problem

The marketplace currently treats every catalog entry as independently usable. That is false for composite plugins. Change Verifier registers `verify_change_gate`, but it resolves `review_changes` and `run_project_tests` only when invoked. Installing Change Verifier by itself therefore succeeds, appears as Running, and then fails during normal use because Reviewer Bot and Test Harness are absent. The catalog and installer have no dependency contract, so neither validation nor installation can prevent this state.

## Decision

Marketplace entries may declare optional `dependencies`, containing stable marketplace entry IDs. The registry rejects malformed, unknown, self-referential, duplicate, or cyclic dependencies at startup. A pure dependency planner expands a requested entry into deterministic dependency-first order.

`POST /api/marketplace/install` installs every missing member of that plan in one npm command, writes every missing profile entry in dependency-first order ahead of Runtime, and creates loader entries in the same order. Existing package/profile snapshots remain the transaction boundary. A normal activation failure removes every loader entry created by the attempt and restores the profile and npm manifests. A leased tool registry keeps the complete package/profile plan and reports that a restart is required, matching the existing tool-plugin behavior.

The same graph also protects later configuration changes. An installed plugin cannot be disabled or uninstalled while another installed and enabled plugin depends on it; the API names the dependents so the user can act deliberately. Enabling a dependent fails unless every declared dependency is installed and enabled. Uninstalling the dependent leaves its providers installed because they may be used independently.

Change Verifier declares `reviewer-bot` and `test-harness`. Its effective capabilities already include command execution, so the dependency declaration does not broaden the permissions shown to the user. The marketplace API exposes dependencies so clients can explain the install plan and offer dependency repair to composite plugins installed before this contract existed. One click produces a usable configuration after the already-required restart.

## Alternatives Rejected

- Only improve the runtime error: this preserves a broken happy path and makes users repair an implementation detail manually.
- Bundle provider plugins inside Change Verifier: this duplicates lifecycle ownership and conflicts when the providers are also installed independently.
- Add a Change Verifier special case in the installer: this cannot validate dependency graphs and guarantees the same defect for the next composite plugin.

## Verification

Tests cover schema acceptance and rejection, dependency ordering, one-command installation, profile and loader ordering, leased-registry persistence, rollback of the complete plan, and dependency-safe enable/disable/uninstall operations. A live marketplace install followed by `verify_change_gate` proves the original user journey.
