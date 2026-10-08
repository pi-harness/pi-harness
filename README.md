# Pi Harness

[![CI](https://img.shields.io/github/actions/workflow/status/pi-harness/pi-harness/ci.yml?branch=main&label=CI)](https://github.com/pi-harness/pi-harness/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40pi-harness%2Fpi-harness?logo=npm)](https://www.npmjs.com/package/@pi-harness/pi-harness)
[![npm downloads](https://img.shields.io/npm/dt/%40pi-harness%2Fpi-harness?label=npm%20downloads)](https://www.npmjs.com/package/@pi-harness/pi-harness)
[![GitHub stars](https://img.shields.io/github/stars/pi-harness/pi-harness?label=GitHub%20stars&logo=github)](https://github.com/pi-harness/pi-harness/stargazers)
[![License](https://img.shields.io/github/license/pi-harness/pi-harness?label=License)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/pi-harness/pi-harness?label=release)](https://github.com/pi-harness/pi-harness/releases)

Pi Harness is a plugin-first web host and CLI for [Pi](https://github.com/earendil-works/pi), built on [DeepSeek Cordis](https://github.com/DeepAgentsLab/cordis). It provides a local browser console, HTTP API, stdio workflows, and a composable plugin runtime. The primary command-line interface is `pih`; `pi-harness` is the companion command for starting the web console.

> Languages: [简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md) · [한국어](docs/README.ko.md) · [Español](docs/README.es.md) · [Français](docs/README.fr.md) · [Deutsch](docs/README.de.md) · [Português (Brasil)](docs/README.pt-BR.md) · [Русский](docs/README.ru.md) · [Italiano](docs/README.it.md) · [العربية](docs/README.ar.md)

## Quick start

Requirements: Node.js 22.19+ and npm 10+.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

`pi-harness` starts the web console, which listens on `http://127.0.0.1:3141` by default. Both surfaces boot with `everyapi/deepseek-v4-flash` and model selection is fail-closed, so the provider must be registered in the agent directory first: provision it with the EveryAPI CLI (install it with `curl -fsSL https://dl.everyapi.ai/install.sh | bash`, or `irm https://dl.everyapi.ai/install.ps1 | iex` on Windows, then run `everyapi use pi-harness`, EveryAPI's tool for this product — `pi-web` is its integration for Pi's own browser UI), or set `PI_HARNESS_PROVIDER` and `PI_HARNESS_MODEL` to a model that agent directory already knows — a fresh Pi installation registers `deepseek/deepseek-v4-flash` and only needs `DEEPSEEK_API_KEY`. That one step registers the catalog for the CLI and the web console together, but it hands the EveryAPI relay key only to the process it starts, so the CLI is launched through it the way [`scripts/pih-local.sh`](scripts/pih-local.sh) launches the console: `everyapi use pi-harness -- <arguments>` with a `pi-harness` shim on `PATH` that execs the binary. For the terminal workflow, use the shorter `pih` command:

```sh
pih "Summarize the current directory"
```

To run from source:

```sh
npm ci
npm run build
npm run web
```

For local development with EveryAPI relay authentication, use `npm run pih-local`. It builds the current workspace and launches the local web entry point through `everyapi use pi-harness` with a temporary `pi-harness` shim on `PATH`, so an older globally installed Pi Harness is not used. Arguments after `--` reach the local server, so `npm run pih-local -- --model <id>` picks the model for that run.

## Web console

![Pi Harness web console](docs/assets/pi-harness-web-console.png)

The public product website lives in `apps/website`. Run it locally with `npm run dev -w @pi-harness/website`; the production bundle is built by `npm run build` alongside the web console.

## What you get

- A Cordis plugin tree for models, resources, sessions, tools, runtime, Web/API, and stdio.
- A project-owned YAML profile system for enabling, configuring, grouping, and composing plugins.
- A separately published `@pi-harness/core` package, so compatible built-in plugin fixes can ship without republishing the launcher, and a `@pi-harness/plugin-api` package carrying only the contract a plugin is written against.
- A non-blocking update check that suggests a compatible core update. Run `npm update --global @pi-harness/pi-harness`; set `PI_HARNESS_DISABLE_UPDATE_CHECK=1` to disable checks.
- Safe defaults: loopback-only web hosting, explicit project trust for executable resources, bounded operations, cancellation, and lifecycle rollback. The unauthenticated API also rejects requests whose `Host` header does not name the bound address and port and cross-site requests whose `Origin` does not match it, which blocks CSRF and DNS rebinding; a reverse proxy must forward the original `Host` header over plain HTTP.

## CLI and profiles

`pih` is the canonical CLI entry point. Use `pi-harness` when you want the browser console.

```sh
pih --profile default "Summarize the current directory"
pih --profile development "Summarize the current directory"
pih --config ./cordis.yml "Summarize the current directory"
pih --profile default --dump-config
```

Profiles are Cordis Loader entry arrays. Each entry has a unique `id` and module `name`, plus optional `config`, `inject`, `group`, or `disabled` fields. See the [profile guide](docs/README.reference.md#profiles) and [plugin catalog](docs/README.reference.md#selected-core-production-plugins).

Common environment variables:

| Variable                          | Purpose                                                                     | Default             |
| --------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| `PI_HARNESS_HOST`                 | Web bind host                                                               | `127.0.0.1`         |
| `PI_HARNESS_PORT`                 | Web bind port                                                               | `3141`              |
| `PI_CODING_AGENT_DIR`             | Pi state and credentials directory                                          | `~/.pi/agent`       |
| `PI_AGENT_DIR`                    | Compatibility alias, read only when `PI_CODING_AGENT_DIR` is unset or blank | `~/.pi/agent`       |
| `PI_HARNESS_HOME`                 | Booted profile copies and marketplace-installed plugins                     | `~/.pi-harness`     |
| `PI_HARNESS_PROVIDER`             | Model provider for the built-in profiles                                    | `everyapi`          |
| `PI_HARNESS_MODEL`                | Model id for the built-in profiles                                          | `deepseek-v4-flash` |
| `PI_HARNESS_ALLOW_REMOTE`         | Allow a non-loopback host when set to `1`                                   | unset               |
| `PI_HARNESS_ALLOWED_HOSTS`        | Extra `Host` header names accepted, comma-separated                         | unset               |
| `PI_HARNESS_DISABLE_UPDATE_CHECK` | Disable the background update check when set to `1`                         | unset               |

The web launcher also takes `--host <host>`, `--port <port>`, `--provider <id>` and `--model <id>`, each winning over the variable of the same name for that run. `everyapi use pi-harness` exports `PI_HARNESS_MODEL` itself, overriding one you exported, so the way to pick a model through it is `everyapi use pi-harness -- --model <id>`.

The web server answers only requests whose `Host` header names loopback, the configured bind host, or (on a wildcard bind such as `0.0.0.0`) one of this machine's own addresses or its hostname; anything else is rejected as a DNS-rebinding attempt. `PI_HARNESS_ALLOWED_HOSTS` adds names the machine does not know about itself, such as a LAN alias or a reverse proxy.

## Architecture

```text
CLI / web launcher
└── Cordis Context
    ├── Loader + Include(profile YAML)
    ├── models → resources → model → session → tools → runtime
    ├── webserver → API routes → browser console
    └── stdio application
```

`@pi-harness/core` is an independent npm package containing multiple Cordis plugins; it is not a single plugin. External plugins can be installed in a project and referenced from its profile.

## Author a plugin

A plugin is an ordinary Cordis plugin written against [`@pi-harness/plugin-api`](packages/plugin-api), which carries the harness service types, config helpers and bounded workspace access without the launcher. Use the [plugin authoring guide](docs/README.reference.md#author-a-plugin) and the working [hello-plugin example](examples/plugin-hello). Treat profiles, plugin packages, and trusted project resources as executable code.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:package
```

Run `npx vitest run scripts/pih-local.test.ts` to verify the local launcher specifically. Keep `pih` as the stable terminal interface and use `pi-harness` when testing the browser console.

CI runs these on Node 22, and `.tool-versions` pins the same major for anyone using asdf or mise. The package only requires Node 22.19+, so a newer runtime works — but built-in modules do change behaviour between majors, and a test that passes locally on Node 24 can still fail in CI.

The reference documents the selected plugin catalog, every HTTP API route, configuration rules, resource limits, failure modes, and security boundaries: [README.reference.md](docs/README.reference.md). Core ships more plugins than the catalog describes; [`packages/plugins`](packages/plugins) is the complete set, and every one of them is installed from the plugin center like a community plugin. A fresh install enables infrastructure only, which is what [`apps/web/profile/cordis.yml`](apps/web/profile/cordis.yml) contains.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=pi-harness/pi-harness&type=Date)](https://www.star-history.com/#pi-harness/pi-harness&Date)

## License

MIT. See [LICENSE](LICENSE).

## Community

- [Contributing](CONTRIBUTING.md) — development setup and pull request guidance.
- [Roadmap](ROADMAP.md) — planned work and priorities.
- [Security policy](SECURITY.md) — private vulnerability reporting.
- [Support](SUPPORT.md) — troubleshooting and bug report guidance.
- [Governance](GOVERNANCE.md) — how technical decisions and maintenance work.

Use [GitHub Discussions](https://github.com/pi-harness/pi-harness/discussions) for questions and proposals. Use an [RFC](RFC.md) for changes that affect public APIs, plugin compatibility, security, or release behavior.
