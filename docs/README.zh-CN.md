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

常用环境变量：`PI_HARNESS_HOST`、`PI_HARNESS_PORT`、`PI_AGENT_DIR`。默认地址为 `http://127.0.0.1:3141`，默认 Pi 数据目录为 `~/.pi/agent`。非回环地址必须显式设置 `PI_HARNESS_ALLOW_REMOTE=1`。

如果安装了 EveryAPI CLI，可运行 `everyapi use pi-harness`，使用隔离的 Pi agent 目录启动。

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

完整插件目录、配置示例、API 路由、资源限制和安全边界请参阅 [英文完整参考](README.reference.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
