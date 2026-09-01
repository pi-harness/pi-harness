# Pi Harness

Pi Harness is a plugin-first web host for [Pi](https://github.com/earendil-works/pi) built on the published DeepSeek Cordis stack. The browser console, HTTP API, static asset server, models, resources, sessions, tools, runtime, logging, timers, and HMR are Cordis plugins. A CLI surface remains available for scripted and terminal workflows.

## Requirements

- Node.js 22.19 or newer
- npm 10 or newer
- Provider credentials supported by Pi for real model requests

## Run from source

```sh
npm ci
npm run build
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js "Explain this repository"
```

## Install the published harness

Users install the single entry package; the scoped `@pi-harness/*` packages are implementation dependencies pulled in automatically.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

## Run the web console

```sh
npm ci
npm run web
```

The web launcher builds the Vite browser bundle, starts the Cordis host, and prints a local URL (by default `http://127.0.0.1:3080`). Set `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, and `PI_AGENT_DIR` to change the bind address, port, or Pi state directory. The browser surface is served by the `@pi-harness/web-app` plugin and talks to `@pi-harness/api-gateway` over `/api/status`, `/api/session`, `/api/sessions`, `/api/session/new`, `/api/session/open`, `/api/models`, `/api/model`, `/api/files`, `/api/prompt`, `/api/abort`, and the `/api/events` Server-Sent Events stream. The launcher refuses non-loopback hosts unless `PI_HARNESS_ALLOW_REMOTE=1` is explicitly set on a trusted network; the API is intended for local use and has no user authentication layer.

The default profile selects `everyapi/deepseek-v4-flash`, stores JSONL sessions under `$PI_AGENT_DIR/sessions`, and loads Pi resources from the current project and agent directory. `PI_AGENT_DIR` defaults to `~/.pi/agent`. When the EveryAPI CLI is installed, launch the integrated web surface with `everyapi use pi-harness`; it provisions an isolated Pi agent directory with the EveryAPI provider catalog and starts Pi Harness on its local loopback URL.

## Architecture

```text
web launcher / CLI launcher
└── Cordis Context
    ├── Loader
    └── Include(profile YAML)
        └── Group
            ├── models      -> piModelRuntime
            ├── resources   -> piResources + extension providers
            ├── model       -> piModels
            ├── session     -> piSession
            ├── tools       -> piTools
            ├── runtime     -> piRuntime
            ├── webserver  -> webServer
            ├── api        -> HTTP JSON routes
            ├── web-app    -> static Vite bundle + SPA fallback
            └── stdio      -> piApplication
```

Cordis owns module loading, configuration validation, dependency injection, activation ordering, lifecycle effects, rollback, grouping, and development HMR. Pi owns model discovery, project resources, session persistence, tool execution, provider calls, and agent events. There is no parallel plugin registry or lifecycle abstraction.

## CLI

```sh
# Built-in production profile
pih --profile default "Summarize the current directory"

# Built-in development profile with logger, timer, and HMR
pih --profile development "Summarize the current directory"

# Project-owned Cordis entry tree
pih --config ./cordis.yml "Summarize the current directory"

# Inspect a profile without importing plugins
pih --profile default --dump-config
```

Launcher options are `--profile`, `--config`, `--dump-config`, `--help`, and `--version`. Remaining arguments are passed unchanged to the active application plugin. The bundled stdio application accepts `--prompt <text>`, a positional prompt, or piped stdin.

The built-in development profile watches the invocation working directory and the launcher automatically supervises a child process with Node's `--expose-internals` flag, which Cordis HMR requires. Cordis performs partial plugin reloads in place and requests a supervised process restart when a framework module changes. Production does not expose Node internals. A custom profile that mounts `@deepseek-ai/cordis-plugin-hmr` must start the CLI entry with `node --expose-internals`.

## Profiles

Profiles are YAML arrays of Cordis Loader entries. Every entry needs a stable `id`, a module `name`, and optional `config`, `inject`, `group`, or `disabled` fields. IDs must be unique across the complete entry tree because Cordis groups share their owning tree's entry store.

Bare module specifiers resolve from the directory containing the profile. Keep project profiles in a package that installs every referenced plugin. Relative specifiers resolve from the same directory.

Pi Harness reads and hot-refreshes profile files but does not persist Loader mutations back into them. This prevents an activation rollback from rewriting a source profile; edit the YAML directly to make changes.

## Author a plugin

[`examples/plugin-hello`](./examples/plugin-hello) is a complete external Cordis plugin. It contributes a native Pi `ToolDefinition`, registers cleanup with `ctx.effect()`, and provides a readiness marker after registration:

```ts
export default {
  name: "pi-hello",
  inject: ["piTools"],
  apply(ctx: Context) {
    ctx.effect(() => ctx.piTools.register(helloTool));
    ctx.provide("piHelloTool", helloTool);
  },
};
```

Custom tools are a startup contract. The runtime leases an immutable tool snapshot while its Pi session exists, so a profile must make runtime activation depend on every tool plugin's marker:

```yaml
- id: tools
  name: "@pi-harness/core/plugins/tools"
  config:
    names: [read, bash, edit, write]
- id: hello
  name: "@pi-harness/plugin-hello"
  config: {}
- id: runtime
  name: "@pi-harness/core/plugins/runtime"
  inject:
    - piHelloTool
  config:
    thinkingLevel: medium
```

This uses Cordis injection for deterministic ordering. A late contribution fails startup instead of being silently omitted from the active AgentSession. When HMR unloads a tool marker, Cordis first disposes the dependent runtime and releases its snapshot; the reloaded tool plugin can then register against the same lifecycle-owned registry.

## Failure and security boundaries

- A profile can load arbitrary Node.js modules. Treat profile files and plugin packages as executable code.
- Missing modules, invalid configuration, unresolved injections, model lookup failures, and plugin activation failures abort startup and dispose the partial tree.
- The runtime does not fall back to a different model or storage backend.
- Signals cancel startup or abort the active Pi run before the Cordis tree is disposed. Runtime abort and root disposal have a five-second deadline, after which the executable forces the signal-compatible exit code.
- The production profile excludes HMR. Development HMR grants access to Node internal ESM loader APIs only in the relaunched development process.
- Existing Pi resources and extensions under `PI_AGENT_DIR` participate in startup and shutdown. Use an isolated agent directory for deterministic tests.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

`npm test` builds every workspace before running Vitest, so Loader integration tests resolve the same package exports shipped to users. Tests use real Cordis contexts and real Pi sessions; deterministic provider fixtures avoid paid network requests.

## Release

Publishing is triggered by a push to `main` (including a merged pull request), or manually with `workflow_dispatch`. The `Release packages` workflow runs the complete test, lint, and diff gate, publishes the user-facing `@pi-harness/pi-harness` package and its six public implementation workspaces to npm, skips package versions that already exist, and creates a matching GitHub Release tag. Users install only `@pi-harness/pi-harness`; the web app and example plugin workspaces are private and are never published.

Before the first release, add the npm automation token as the GitHub Actions secret `NPM_TOKEN`. The workflow passes the secret through `NODE_AUTH_TOKEN` and publishes to npm without provenance because this repository is private and npm rejects provenance attestations from private GitHub sources. The token must be allowed to publish the entry package and six implementation package names and, if npm two-factor authentication is enabled, use an automation-compatible publish policy. Bump all published package versions together and update their internal `@pi-harness/*` dependency versions before merging to `main`; the merge then publishes and creates the matching GitHub Release automatically.

## Workspace layout

- `packages/core`: Cordis boot host, typed Pi services, runtime plugins, and built-in profiles
- `packages/cli`: launcher argument, process, stdio, signal, and development re-exec handling
- `packages/host-webserver`: Cordis-owned HTTP server and route lifecycle
- `packages/api-gateway`: Cordis API plugin for status, live sessions, model selection, workspace files, prompts, abort, and SSE events
- `packages/client-web`: browser-side Cordis plugin tree and console surface
- `packages/bundle-web-app`: static frontend and SPA fallback plugin
- `apps/web`: Vite entrypoint and production web launcher
- `examples/plugin-hello`: lifecycle-safe external Pi tool plugin
- `docs/plans`: accepted architecture and implementation plan
