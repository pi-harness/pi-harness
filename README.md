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

The web launcher builds the Vite browser bundle, starts the Cordis host, and prints a local URL (by default `http://127.0.0.1:3141`). Set `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, and `PI_AGENT_DIR` to change the bind address, port, or Pi state directory. The browser surface is served by the bundled `@pi-harness/web-app` plugin and talks to the bundled `@pi-harness/api-gateway` over `/api/status`, `/api/session`, `/api/sessions`, `/api/session/new`, `/api/session/open`, `/api/models`, `/api/model`, `/api/files`, `/api/prompt`, `/api/abort`, and the `/api/events` Server-Sent Events stream. The launcher refuses non-loopback hosts unless `PI_HARNESS_ALLOW_REMOTE=1` is explicitly set on a trusted network; the API is intended for local use and has no user authentication layer.

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

An application plugin implements `run(signal?: AbortSignal): Promise<number>`. The signal is aborted when a signal or an exit request ends the run, and a surface that can block must unwind on it; the launcher force-exits one that does not.

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

Launcher options are `--profile`, `--config`, `--dump-config`, `--help`, and `--version`. `--profile` and `--config` also accept the inline `--profile=<name>` and `--config=<path>` spellings. The launcher stops recognizing its own options at the first argument that is not one of them, so `pih explain what tar -h prints` sends the whole sentence to the agent instead of printing usage.

Remaining arguments are passed unchanged to the active application plugin, including a `--` separator, which the launcher forwards rather than consuming. The bundled stdio application accepts `--prompt <text>`, `--prompt=<text>`, a positional prompt, or piped stdin, and rejects an option-shaped positional prompt unless `--` precedes it:

```sh
pih -- -v is a version flag, explain it
```

`PI_AGENT_DIR` must name an absolute directory. An empty or whitespace-only value is treated as unset, and a relative value is resolved against the invocation directory, so the credential store can never land in the current working directory by accident.

The built-in development profile watches the invocation working directory and the launcher automatically supervises a child process with Node's `--expose-internals` flag, which Cordis HMR requires. Cordis performs partial plugin reloads in place and requests a supervised process restart when a framework module changes. The supervisor backs off between restarts and gives up after five restarts in ten seconds so a reload loop cannot fork processes without bound. Production does not expose Node internals.

A custom profile that mounts `@deepseek-ai/cordis-plugin-hmr` must start the CLI entry with `node --expose-internals`. Such a process is not supervised, so a Cordis full-reload request writes a diagnostic to stderr and leaves the run in place instead of terminating with a restart exit code that nothing would act on.

## Profiles

Profiles are YAML arrays of Cordis Loader entries. Every entry needs a stable `id`, a module `name`, and optional `config`, `inject`, `group`, or `disabled` fields. IDs must be unique across the complete entry tree because Cordis groups share their owning tree's entry store.

Bare module specifiers resolve from the directory containing the profile, so a project profile can name any plugin installed in that project. Relative specifiers resolve from the same directory. Ids must be unique across the complete entry tree, and a collision fails startup rather than silently dropping one of the colliding entries.

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
- Project-local Pi resources under the invocation directory's `.pi/` — extensions, settings, and system-prompt overrides — are executable code owned by whoever wrote the repository. They are loaded only when the project is trusted: a decision recorded by Pi's own trust store for that directory, or `trustProject: true` on the `pi-resources` entry. An untrusted project is reported on stderr and its resources are skipped, so `cd`-ing into a cloned repository and running `pih` does not execute its extensions.
- Extensions under `PI_AGENT_DIR` are user-owned and always load. `session_shutdown` runs before the Pi session is disposed, so an extension's session-scoped resources are released on every exit path.
- A plugin cannot register a tool whose name belongs to a Pi built-in (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`); the collision fails startup instead of silently replacing the built-in in the model's tool table.
- Missing modules, invalid configuration, unresolved injections, model lookup failures, and plugin activation failures abort startup and dispose the partial tree. Configuration validation rejects unknown keys, so a mistyped `name:` in place of `names:` fails startup instead of silently restoring a default toolset.
- The runtime does not fall back to a different model or storage backend. A Pi extension that fails to load aborts startup instead of leaving the agent with a silently reduced tool set.
- The bundled stdio application writes the assistant's answer to stdout and everything else to stderr: one line per tool execution, one per failed tool, and one per provider retry. A run that produces no assistant text, or whose response is truncated by the model's output limit, exits non-zero.
- A closed stdout (`pih ... | head`) stops output without killing the process, so the Cordis tree is still disposed.
- Provider traffic goes through the proxy `HTTP_PROXY`, `HTTPS_PROXY` or the `httpProxy` setting names, using Pi's own dispatcher so the harness and `pi` behave identically on a proxied network.
- An application surface receives an `AbortSignal` and shares the shutdown deadline: one that ignores the signal is force-exited rather than keeping the process alive. Buffered output is flushed before a forced exit, except on a repeated signal, which leaves immediately.
- Tools an extension registers but the profile does not list are reported on stderr instead of disappearing from the model's tool table.
- Signals cancel startup or abort the active Pi run before the Cordis tree is disposed. Runtime abort and root disposal have a five-second deadline, after which the executable forces the signal-compatible exit code. A repeated signal during that window forces the exit immediately. A pending prompt read is cancelled too, so a signal never leaves the process alive holding an open stdin pipe, and cancelling the interactive prompt with Ctrl-C exits 130 rather than the usage code 2.
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

## License

MIT. See [LICENSE](./LICENSE).
