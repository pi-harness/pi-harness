# Pi Harness 工作区说明

## 本地认证验证

使用当前工作区代码并通过 EveryAPI 注入 relay 认证时，运行：

```sh
npm run pih-local
# 或直接执行：./scripts/pih-local.sh
```

脚本会先执行 `npm run build:web`，再通过临时 PATH shim 启动当前构建出的 `apps/web/server-dist/bin.js`。这样不会误用 PATH 中可能过期的全局 `pi-harness`，也不需要手动复制密钥。

可将 EveryAPI 参数继续传给启动器，例如：

```sh
./scripts/pih-local.sh --model doubao-seed-2.0-lite
```

启动后打开终端输出的地址（默认 `http://127.0.0.1:3141`），按 Ctrl-C 停止。脚本退出时会自动删除临时 shim。

## 常用验证命令

```sh
npm run build
npx vitest run
npx vitest run scripts/pih-local.test.ts
```
