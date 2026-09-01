# Pi Harness

Pi Harness is a plugin-first command-line host for [Pi](https://github.com/earendil-works/pi) built on the published DeepSeek Cordis stack. The launcher only resolves a profile, provides process services, handles signals, and disposes the root context. Models, resources, sessions, tools, the Pi runtime, application surfaces, logging, timers, and HMR are Cordis plugins.

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

The default profile selects `deepseek/deepseek-v4-flash`, stores JSONL sessions under `$PI_AGENT_DIR/sessions`, and loads Pi resources from the current project and agent directory. `PI_AGENT_DIR` defaults to `~/.pi/agent`.

## Architecture

```text
pih launcher
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
            └── stdio       -> piApplication
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
- Missing modules, invalid configuration, unresolved injections, model lookup failures, and plugin activation failures abort startup and dispose the partial tree. Configuration validation rejects unknown keys, so a mistyped `name:` in place of `names:` fails startup instead of silently restoring a default toolset.
- The runtime does not fall back to a different model or storage backend.
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

The repository currently has no GitHub Actions workflow because the target organization has no self-hosted runner attached. Local commands above are the release gate until runner infrastructure is available.

## Workspace layout

- `packages/core`: Cordis boot host, typed Pi services, runtime plugins, and built-in profiles
- `packages/cli`: launcher argument, process, stdio, signal, and development re-exec handling
- `examples/plugin-hello`: lifecycle-safe external Pi tool plugin
- `docs/plans`: accepted architecture and implementation plan
