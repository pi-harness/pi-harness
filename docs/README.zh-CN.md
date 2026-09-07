# Pi Harness

Pi Harness 是一个以插件为核心的 [Pi](https://github.com/earendil-works/pi) Web 主机，基于 DeepSeek Cordis 构建。它同时提供浏览器控制台、HTTP API 和 CLI。

语言： [English](../README.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## 安装

要求 Node.js 22.19+ 和 npm 10+：

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

用户只需安装主包；`@pi-harness/core` 等实现依赖会自动安装。

## 从源码运行

```sh
npm ci
npm run build
node packages/cli/dist/bin.js --help
npm run web
```

## 更新与配置

启动时会后台检查兼容的 `@pi-harness/core` 更新，不阻塞启动。发现更新时会输出命令；网络失败会被忽略。运行 `npm update --global @pi-harness/pi-harness` 更新，或设置 `PI_HARNESS_DISABLE_UPDATE_CHECK=1` 关闭检查。

常用环境变量：`PI_HARNESS_HOST`、`PI_HARNESS_PORT`、`PI_AGENT_DIR`、`PI_HARNESS_PROVIDER`、`PI_HARNESS_MODEL`。默认地址为 `http://127.0.0.1:3141`，默认 Pi 数据目录为 `~/.pi/agent`。非回环地址必须显式设置 `PI_HARNESS_ALLOW_REMOTE=1`。

Web 控制台的 profile（[`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)）默认选择 `everyapi/deepseek-v4-flash`，而模型选择是 fail-closed 的：当前 `PI_AGENT_DIR` 里没有注册该 provider 时，启动会直接以 `Pi model is not registered: <provider>/<model>` 失败，而不会回退到别的 provider。所以全新安装后要先准备好模型目录：安装了 EveryAPI CLI 就运行 `everyapi use pi-harness`，它会用隔离的 Pi agent 目录写入 EveryAPI provider 目录并启动；或者把 `PI_HARNESS_PROVIDER` 和 `PI_HARNESS_MODEL` 指向该 agent 目录里已经注册的模型。CLI 内置的 `default` profile 选择的则是 `deepseek/deepseek-v4-flash`。

## CLI

```sh
pih --profile default "总结当前目录"
pih --profile development "总结当前目录"
pih --config ./cordis.yml "总结当前目录"
pih --profile default --dump-config
```

启动器选项：`--profile`、`--config`、`--dump-config`、`--help`、`--version`。配置文件是 Cordis Loader 条目数组；每个条目需要唯一 `id`、模块 `name`，以及可选的 `config`、`inject`、`group`、`disabled`。

## 架构

启动器加载 Cordis profile，由 Loader、Include 和 Group 按依赖顺序挂载模型、资源、会话、工具、运行时、Web/API 和 stdio 插件。`@pi-harness/core` 是独立 npm 包，内含多个可按 profile 加载的插件；它不是单一插件。

## 插件与安全

默认 profile 包含 Pi Harness 的生产插件。第三方插件可作为 npm 包安装后写入自己的 `cordis.yml`。Profile 和项目资源会执行 Node.js 代码，请只信任来源明确的文件。缺失模块、配置错误、注入失败、模型查找失败和插件激活失败都会终止启动并回滚部分状态。

## 开发与发布

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

主包和独立的 `@pi-harness/core` 都可发布。只修复内置插件时，发布兼容的 core patch 版本即可；主包通过 `^0.1.x` 依赖获取更新。

节选的插件目录、配置示例、全部 HTTP API 路由、资源限制和安全边界请参阅 [英文完整参考](README.reference.md)。core 附带的插件比该目录收录的更多：[`packages/plugins`](../packages/plugins) 是完整集合，其中每个插件都和社区插件一样从插件中心安装。全新安装只启用基础设施，也就是 [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml) 的内容。

## 许可证

MIT，见 [LICENSE](LICENSE)。
