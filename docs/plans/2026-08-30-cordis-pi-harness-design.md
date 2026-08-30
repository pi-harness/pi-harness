# Cordis Pi Harness Design

## Goal

Build a production-grade Pi harness whose application surfaces and runtime capabilities are all Cordis plugins, while delegating agent execution to the stable Pi coding-agent SDK.

## Architecture

The launcher owns only argument parsing, profile resolution, signal handling, and bounded shutdown. It creates a Cordis root context, mounts Loader, registers Include and Group built-ins, then mounts one YAML profile. Timer, HMR, logging, models, resources, sessions, tools, the Pi runtime, and the stdio application are ordinary loader entries. The implementation uses the published DeepSeek-scoped Cordis packages because those packages contain the lifecycle and transactional reload hardening used by DeepSeek Harness.

Pi-specific plugins communicate through typed Cordis services. `models` owns an agent-directory-isolated model runtime and the requested model identity, `resources` owns the Pi resource loader and registers extension providers, `model` resolves the final model after resource activation, `session` owns persistence selection, `tools` contributes the active tool set, and `runtime` injects those services to create and dispose an `AgentSession`. Application plugins inject `piRuntime`; the first release ships a line-oriented stdio surface suitable for terminals and process integration.

## Plugin and profile model

Every plugin uses Cordis's function/object/class plugin contract, explicit `inject` declarations, standard-schema configuration, `ctx.provide()` services, and `ctx.effect()` cleanup. No second registry, event bus, dependency graph, or lifecycle abstraction is introduced. Profiles are YAML entry trees interpreted by Include and Loader. The built-in default profile is immutable package data; user profiles can replace rows or compose groups without changing launcher code. Development profiles may mount Timer and HMR; production profiles do not hot-reload a live session.

## Data flow

`pih --profile default` resolves the profile, creates a root Context, provides an immutable launch-options service, mounts Loader and the root Include, waits for every enabled fiber, then commits application readiness. The models, resources, model selection, session, tools, and runtime entries become active when their injected services exist. The stdio application reads one prompt, calls the active Pi session, renders text deltas, and requests bounded shutdown after the run settles. Signals cancel startup or abort the active run, then dispose the root fiber within a fixed deadline.

## Failure and safety semantics

Profile resolution, import, configuration, missing injection, unknown tools, model lookup, and activation failures abort startup and dispose the partial tree. A plugin never silently falls back to a different model or storage backend. Runtime effects are registered before long-lived work and dispose idempotently. Project resource loading uses Pi's trust and resource-loader behavior rather than importing project code directly in the launcher. HMR is opt-in and excluded from the default production profile; the development launcher supervises full-reload restarts while Cordis handles partial plugin reloads in place.

## Verification

Unit tests exercise profile resolution, activation diagnostics, startup rollback, and CLI parsing. Integration tests mount real Cordis Loader/Include trees with local fixture plugins, then mount the real Pi runtime against a deterministic in-process provider so no API key or paid endpoint is used. CLI tests verify help, config inspection, missing profile errors, and a complete prompt/response process. The delivery gate is unit and integration tests, TypeScript checking, linting, build, package-boundary checks, and installed-package smoke tests.
