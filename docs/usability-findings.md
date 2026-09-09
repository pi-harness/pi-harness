# Pi Harness 体验问题记录

## 使用场景

用 pi-harness web 控制台让 agent 做一个完整的 FPS 射击游戏（raycasting 引擎），过程中记录发现的问题。

---

## 已确认并修复

### 1. API Gateway dist 与源码不同步 — 事件内存泄漏 (Critical)

**现象**: 运行 agent 10 分钟后，服务器 RSS 从 ~200MB 涨到 1034MB，浏览器标签页崩溃。
**根因**: `packages/api-gateway/dist/index.js` 的 `handleEvent` 函数缺少三个关键逻辑：

- 没有 `event.type !== "message_update"` 过滤 → 所有流式 delta 全部进入 retained 数组
- 没有 `stampEvent` 时间戳
- 没有 `MAX_RETAINED_EVENTS = 2000` 裁剪 → 数组无限增长

源码 (index.ts:843-857) 有这些逻辑，但 dist 是旧版编译产物。

**触发路径**: `npm run build:web` 不会单独 rebuild api-gateway（它只跑 tsc + vite），所以 api-gateway 的 dist 可能长期落后于源码。

**修复**: 手动 `npm run build -w @pi-harness/api-gateway` 后 dist 同步。
**验证**: 修复后同样场景 events 从79,251 降到 9，内存从 1034MB 降到 212MB。

**建议**:

- `build:web` 脚本应显式 rebuild api-gateway（当前链式 build 不包含它）
- 或者加一个 CI check 对比 src/dist 的关键函数是否存在

---

### 2. @pi-harness/plugin-api symlink 缺失

**现象**: `npm run build -w @pi-harness/core` 报 `Cannot find module '@pi-harness/plugin-api'`。
**根因**: `node_modules/@pi-harness/` 下没有 `plugin-api` 的 symlink，其他包（core, cli, host-webserver 等）都有。
**修复**: `ln -sf ../../packages/plugin-api node_modules/@pi-harness/plugin-api`
**建议**: 检查 npm workspaces 配置或 postinstall 脚本，确保所有 workspace 包都有 symlink。

---

## 已观察到但未修复（在 dependency 中）

### 3. MCP bridge 反复报错 "lean-ctx ENOENT"

**现象**: 服务器启动后日志反复输出：

```
[lean-ctx MCP bridge] Transport error: spawn lean-ctx ENOENT
[lean-ctx MCP bridge] Failed to start: spawn lean-ctx ENOENT
[lean-ctx MCP bridge] Max reconnect attempts (3) reached. MCP tools unavailable.
```

**影响**: 无功能影响（MCP tools 本来就不需要），但日志噪音大，且重试3次浪费启动时间。
**建议**: 如果 lean-ctx 不是必需的，启动时 should probe availability first，不要盲目 spawn。

### 4. MCP initialization failed — stale ctx after session switch

**现象**: 每次通过 web 控制台新建/切换会话后，日志出现：

```
MCP initialization failed: This extension ctx is stale after session replacement or reload.
```

重复 11+ 次。
**根因**: `@earendil-works/pi-coding-agent` 的 extension runner 在 session 切换后用旧 ctx 初始化 MCP。
**影响**: MCP 功能不可用；日志噪音。
**建议**: 需要在 pi-coding-agent 侧修复，session 切换时应重新初始化 MCP bridge。

---

### 8. 思考/生成阶段无视觉反馈 (已修复)

**现象**: Agent 运行时只显示静态的"思考中…"或"正在生成…"文字，感觉像卡住了。
**修复**:

- `.streaming-placeholder` 添加了 spinner 旋转动画 + 文字呼吸动画
- `.reasoning-head` 添加了 "..." 跳动动画（CSS `content` + `steps()`）
- 新增 `streaming-elapsed` 计时器，显示已运行秒数（如 "思考中… 8s"）
  **文件**:
- `packages/client-web/src/react-room.tsx` — 添加 `streamingStartedAt` / `elapsedSeconds` state + `useEffect` 计时器
- `apps/web/src/style.css` — 添加 `.streaming-spinner`、`.streaming-elapsed`、`@keyframes` 样式

---

## 使用体验问题

### 5. 复杂任务思考时间过长，缺乏进度反馈

**现象**: 使用 deepseek-v4-flash 模型生成完整 FPS 游戏时，思考阶段持续 10+ 分钟无任何输出。虽然有 "思考中… Xs" 计时器，但用户无法判断模型是否真正在工作。
**影响**: 用户体验差，容易误以为卡死。
**建议**:

- 显示模型的 thinking 内容（如果模型支持 streaming thinking）
- 添加超时警告（如 "已运行 5 分钟，是否继续？"）
- 在状态栏显示更醒目的运行时长

### 6. 新建会话的工作区选择器不支持手动输入路径

**现象**: 新建会话时弹出"选择工作区"对话框，只能从 Finder 选目录或点已有的 worktree。没有文本输入框直接粘贴路径。
**场景**: 我想让 agent 在 `/tmp/fps-game` 工作，但这个目录不在 git worktree 里，只能通过 Finder 导航。
**建议**: 添加一个路径输入框，支持直接粘贴绝对路径。

### 7. 版本号显示不一致

**现象**: 侧边栏底部显示 "pi harness 0.1.10"，但 package.json 是 0.1.36。
**根因**: 可能是 web-app 的 package.json 或构建时写入的版本号没有同步更新。

### 8. 会话列表标题截断问题

**现象**: 长 prompt 在会话列表中被截断为一行，完全看不到有用信息。
**示例**: "Create a complete FPS (First Person Shooter) game in /tmp/fps-game using a single index.html file with embedded CSS and JavaScript. Use a raycasting engine (Wolfenstein 3D style) for 3D-like first-person perspective..."
**建议**: 显示首行摘要或用户自定义会话名称，而非完整 prompt。

---

## 测试总结

### FPS 游戏测试结果（6 轮迭代）

使用 doubao-seed-2.0-lite 模型通过 web 控制台进行了 6 轮迭代：

| 轮次 | 任务                             | 结果               | 行数 |
| ---- | -------------------------------- | ------------------ | ---- |
| 1    | 基础 raycasting 引擎 + WASD 移动 | 303 行基础 demo    | 303  |
| 2    | 添加武器系统、敌人 AI、血量弹药  | 武器/敌人/HUD/拾取 | 541  |
| 3    | 添加音效、开始/结束画面、计分    | 游戏状态机完成     | 603  |
| 4    | 添加实际音效、多关卡、伤害闪烁   | 关卡切换 + 音效    | 676  |
| 5    | 添加暂停菜单、连杀提示、关卡过渡 | 3 关卡完整         | 954  |
| 6    | 最终打磨：粒子效果、UI 优化      | 984 行完整游戏     | 984  |

**最终游戏包含**:

- 3 种武器（手枪/霰弹枪/步枪），1/2/3 键切换
- 3 种敌人（士兵/冲锋者/重装），不同 AI 行为
- 3 个关卡，难度递增
- 血量/弹药系统 + 拾取物
- Web Audio API 音效
- 开始/暂停/游戏结束/胜利/关卡过渡画面
- 小地图、HUD、十字准星、连杀提示
- 伤害闪烁、枪口火焰、子弹粒子效果

**模型速度对比**:

- deepseek-v4-flash: 思考 10+ 分钟无输出，不适合复杂代码生成
- doubao-seed-2.0-lite: 每轮 30-60 秒完成，适合迭代开发

### 已修复问题汇总

1. **事件内存泄漏** (Critical) — dist 与源码不同步，events 数组无限增长
2. **plugin-api symlink 缺失** — 导致 core 构建失败
3. **思考/生成动画** — 添加了 spinner、dots 动画和计时器

### 待解决问题

1. MCP bridge lean-ctx ENOENT 错误
2. MCP stale ctx after session switch
3. 复杂任务思考时间过长，缺乏进度反馈
4. 工作区选择器不支持手动输入路径
5. 版本号显示不一致
6. 会话列表标题截断问题

### 多轮迭代观察

- **事件过滤有效**: 6 轮迭代共723 events，无 message_update 泄漏
- **内存稳定**: 运行期间 RSS 在 212-380MB 范围，无增长趋势
- **计时器有用**: "思考中… Xs" 计时器让用户知道 agent 在工作
- **模型切换重要**: 复杂任务需要快速模型，deepseek-v4-flash 会卡住

---

## 性能基线

| 指标             | 修复前   | 修复后                  |
| ---------------- | -------- | ----------------------- |
| 同场景 events 数 | 79,251   | 9 (单轮) / 723 (6轮)    |
| 服务器 RSS       | 1,034 MB | 212-380 MB              |
| 浏览器           | 崩溃     | 正常                    |
| 思考动画         | 无       | spinner + dots + 计时器 |
| FPS 游戏         | 未完成   | 984 行完整游戏          |
