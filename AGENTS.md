# Pi Harness 工作区说明

## 本地认证验证

使用当前工作区代码并通过 EveryAPI 注入 relay 认证时，运行：

```sh
npm run pih-local
# 或直接执行：./scripts/pih-local.sh
```

脚本会先执行 `npm run build:web`，再通过 EveryAPI 的认证启动流程运行 Pi Harness，并设置 `PI_HARNESS_WEB_DIST` 让服务加载当前工作区构建出的前端资源。服务端执行文件由 EveryAPI 管理，不需要手动复制密钥。模型可在控制台的模型选择器中切换。

启动后打开终端输出的地址（默认 `http://127.0.0.1:3141`），按 Ctrl-C 停止。脚本不会修改全局安装，只通过进程环境选择当前工作区的前端资源。

## 常用验证命令

```sh
npm run build
npx vitest run
npx vitest run scripts/pih-local.test.ts
```
