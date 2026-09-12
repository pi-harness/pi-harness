# Pi Harness 工作区说明

## 本地认证验证

使用当前工作区代码并通过 EveryAPI 注入 relay 认证时，运行：

```sh
npm run pih-local
# 或直接执行：./scripts/pih-local.sh
```

脚本会先执行 `npm run build:web`，再通过临时 `pi-web` PATH shim 让 EveryAPI 的认证启动流程运行当前工作区构建出的 `apps/web/server-dist/bin.js`。这样既能使用 EveryAPI relay 认证，也不会误用 PATH 中可能过期的全局 Pi Harness。模型可在控制台的模型选择器中切换；传给脚本的参数会原样转发给本地服务。

启动后打开终端输出的地址（默认 `http://127.0.0.1:3141`），按 Ctrl-C 停止。脚本不会修改全局安装，退出时会删除临时 shim。

## 常用验证命令

```sh
npm run build
npx vitest run
npx vitest run scripts/pih-local.test.ts
```
