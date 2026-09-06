# Pi Harness

[![CI](https://img.shields.io/github/actions/workflow/status/pi-harness/pi-harness/ci.yml?branch=main&label=CI)](https://github.com/pi-harness/pi-harness/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40pi-harness%2Fpi-harness?logo=npm)](https://www.npmjs.com/package/@pi-harness/pi-harness)
[![npm downloads](https://img.shields.io/npm/dm/%40pi-harness%2Fpi-harness?label=npm%20downloads)](https://www.npmjs.com/package/@pi-harness/pi-harness)
[![GitHub stars](https://img.shields.io/github/stars/pi-harness/pi-harness?label=stars&logo=github)](https://github.com/pi-harness/pi-harness/stargazers)
[![License](https://img.shields.io/github/license/pi-harness/pi-harness?label=license)](LICENSE)

Pi Harness is a plugin-first web host and CLI for [Pi](https://github.com/earendil-works/pi), built on [DeepSeek Cordis](https://github.com/DeepAgentsLab/cordis). It provides a local browser console, HTTP API, stdio workflows, and a composable plugin runtime.

> Languages: [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## Quick start

Requirements: Node.js 22.19+ and npm 10+.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

The web console listens on `http://127.0.0.1:3141` by default. For a terminal workflow:

```sh
pih "Summarize the current directory"
```

To run from source:

```sh
npm ci
npm run build
npm run web
```

## What you get

- A Cordis plugin tree for models, resources, sessions, tools, runtime, Web/API, and stdio.
- A project-owned YAML profile system for enabling, configuring, grouping, and composing plugins.
- A separately published `@pi-harness/core` package, so compatible built-in plugin fixes can ship without republishing the launcher.
- A non-blocking update check that suggests a compatible core update. Run `npm update --global @pi-harness/pi-harness`; set `PI_HARNESS_DISABLE_UPDATE_CHECK=1` to disable checks.
- Safe defaults: loopback-only web hosting, explicit project trust for executable resources, bounded operations, cancellation, and lifecycle rollback.

## CLI and profiles

```sh
pih --profile default "Summarize the current directory"
pih --profile development "Summarize the current directory"
pih --config ./cordis.yml "Summarize the current directory"
pih --profile default --dump-config
```

Profiles are Cordis Loader entry arrays. Each entry has a unique `id` and module `name`, plus optional `config`, `inject`, `group`, or `disabled` fields. See the [profile guide](README.reference.md#profiles) and [plugin catalog](README.reference.md#selected-core-production-plugins).

Common environment variables:

| Variable                          | Purpose                                             | Default       |
| --------------------------------- | --------------------------------------------------- | ------------- |
| `PI_HARNESS_HOST`                 | Web bind host                                       | `127.0.0.1`   |
| `PI_HARNESS_PORT`                 | Web bind port                                       | `3141`        |
| `PI_AGENT_DIR`                    | Pi state and credentials directory                  | `~/.pi/agent` |
| `PI_HARNESS_ALLOW_REMOTE`         | Allow a non-loopback host when set to `1`           | unset         |
| `PI_HARNESS_DISABLE_UPDATE_CHECK` | Disable the background update check when set to `1` | unset         |

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

Use the [plugin authoring guide](README.reference.md#author-a-plugin) and the working [hello-plugin example](examples/plugin-hello). Treat profiles, plugin packages, and trusted project resources as executable code.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:package
```

The complete reference documents every built-in plugin, API route, configuration rule, resource limit, failure mode, and security boundary: [README.reference.md](README.reference.md).

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=pi-harness/pi-harness&type=Date)](https://www.star-history.com/#pi-harness/pi-harness&Date)

## License

MIT. See [LICENSE](LICENSE).
