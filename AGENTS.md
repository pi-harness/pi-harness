# Repository Guidelines

Pi Harness is a TypeScript monorepo providing the `pih` CLI and the `pi-harness` web console. Keep changes focused and preserve the package boundaries under `packages/` and `apps/`.

## Project Structure

- `packages/cli`: canonical `pih` command-line launcher.
- `packages/core`, `packages/plugin-api`, and `packages/plugins`: runtime, plugin contract, and built-in plugins.
- `apps/web`: web server entry point and bundled profile; `apps/web/src` contains server code.
- `apps/website`: public product website and marketing entry point.
- `packages/bundle-web-app` and `packages/client-web`: browser application and client code.
- `apps/*/test`, `packages/*/test`, and `scripts/*.test.ts`: Vitest tests.
- `docs/` and `docs/assets/`: translated/reference documentation and images.

## Build, Test, and Development

```sh
npm ci                         # install locked dependencies
npm run build                  # build every workspace
npm run build:web              # build the web-capable distribution
npx vitest run                 # run the full test suite
npm run lint:check             # run ESLint without modifying files
npm run pih-local              # build and launch the local authenticated web console
```

Use `pih "your prompt"` for terminal workflows and `pi-harness` for the browser console. The local launcher defaults to `http://127.0.0.1:3141`.

## Coding and Testing Conventions

Use TypeScript with the repository's existing formatting and ESLint rules; prefer clear names and small workspace-local modules. Put tests beside the package they exercise, use `.test.ts`, and run targeted tests during development (for example, `npx vitest run scripts/pih-local.test.ts`).

## Commits and Pull Requests

Write short imperative commit subjects, scoped when useful (for example, `web: reject invalid host headers`). PRs should explain user-visible behavior, include relevant tests and documentation updates, and include screenshots for browser UI changes. Keep generated build output out of commits unless the package workflow explicitly requires it.

## 本地认证验证

使用当前工作区代码并通过 EveryAPI 注入 relay 认证时，运行：

```sh
npm run pih-local
# 或直接执行：./scripts/pih-local.sh
```

脚本会先执行 `npm run build:web`，再通过临时 `pi-harness` PATH shim 让 `everyapi use pi-harness` 的认证启动流程运行当前工作区构建出的 `apps/web/server-dist/bin.js`（`pi-web` 是 EveryAPI 给 Pi 自带浏览器 UI 的集成，是另一个产品，不要用它）。这样既能使用 EveryAPI relay 认证，也不会误用 PATH 中可能过期的全局 Pi Harness。传给脚本的参数会原样转发给本地服务：`everyapi use pi-harness` 会自己导出 `PI_HARNESS_MODEL` 覆盖你导出的值，所以要指定模型请用 `npm run pih-local -- --model <id>`；启动后也可在控制台的模型选择器中切换。

隔离测试状态时设置 Pi 上游原生变量 `PI_CODING_AGENT_DIR`；兼容别名 `PI_AGENT_DIR` 也可用，`pih-local` 会把它桥接给 EveryAPI。若两者都设置，以 `PI_CODING_AGENT_DIR` 为准。

启动后打开终端输出的地址（默认 `http://127.0.0.1:3141`），按 Ctrl-C 停止。脚本不会修改全局安装，退出时会删除临时 shim。

需要用当前源码构建去测试另一个项目时，设置 `PIH_LOCAL_CWD=/path/to/project npm run pih-local`。构建仍来自当前 checkout，但控制台、会话与 agent 工具会以目标项目为工作目录；也可从目标目录执行 `npm --prefix /path/to/pi-harness run pih-local`，脚本会读取 npm 的 `INIT_CWD`。

## 常用验证命令

```sh
npm run build
npx vitest run
npx vitest run scripts/pih-local.test.ts
```
