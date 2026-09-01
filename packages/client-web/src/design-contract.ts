export interface DesignWorkspace {
  readonly path: string;
  readonly sessions: string;
  readonly live: boolean;
  readonly branch: string;
  readonly dirty: string;
}
export interface DesignSession {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly state: "running" | "ok" | "warn" | "error";
  readonly group: "今天" | "昨天" | "更早";
  readonly ws: string;
}
export interface DesignTurn {
  readonly kind: "user" | "reasoning" | "plugin" | "tool" | "text" | "approval" | "subagent" | "todo" | "stats";
  readonly text?: string;
  readonly name?: string;
  readonly hook?: string;
  readonly target?: string;
  readonly output?: string;
  readonly dur?: string;
  readonly stat?: string;
  readonly statFg?: string;
  readonly glyph?: string;
  readonly isDiff?: boolean;
  readonly diff?: readonly { no: string; sign: string; text: string }[];
  readonly preset?: string;
  readonly goal?: string;
  readonly lineage?: string;
  readonly steps?: readonly { tool: string; target: string; dur: string }[];
  readonly verdict?: string;
  readonly progress?: string;
  readonly todos?: readonly { text: string; done: boolean }[];
  readonly stats?: readonly string[];
}
export interface DesignEvent {
  readonly ts: string;
  readonly source: string;
  readonly summary: string;
  readonly by: string;
  readonly dur: string;
}
export interface DesignPlugin {
  readonly name: string;
  readonly ver: string;
  readonly capability: string;
  readonly on: boolean;
  readonly update: boolean;
  readonly local?: boolean;
  readonly desc: string;
  readonly hooks: readonly string[];
}
export interface DesignProvider {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly ok: boolean;
  readonly protocol: "openai" | "anthropic";
  readonly baseUrl: string;
  readonly key: string;
  readonly models: readonly string[];
  readonly latency: string;
  readonly by: string;
}

export const DESIGN_WORKSPACES: readonly DesignWorkspace[] = [
  { path: "~/work/checkout-svc", sessions: "6", live: true, branch: "fix/3ds-timeout", dirty: "4 处未提交" },
  { path: "~/work/pi-harness", sessions: "12", live: false, branch: "main", dirty: "干净" },
  { path: "~/scratch/spike-otel", sessions: "2", live: false, branch: "spike", dirty: "12 处未提交" },
];

export const DESIGN_SESSIONS: readonly DesignSession[] = [
  { id: "s1", title: "修复 3DS 超时导致的支付失败", meta: "ds-coder-v3 · 14 步 · 4 分钟前", state: "running", group: "今天", ws: "~/work/checkout-svc" },
  { id: "s2", title: "为 refund 模块补单测", meta: "ds-coder-v3 · 22 步 · 1 小时前", state: "ok", group: "今天", ws: "~/work/checkout-svc" },
  { id: "s3", title: "梳理仓库结构与主要包", meta: "ds-chat · 6 步 · 3 小时前", state: "ok", group: "今天", ws: "~/work/pi-harness" },
  { id: "s4", title: "把 webhook 重试改成指数退避", meta: "ds-coder-v3 · 31 步 · 昨天", state: "warn", group: "昨天", ws: "~/work/checkout-svc" },
  { id: "s5", title: "升级 pnpm 到 10 并修构建", meta: "ds-coder-v3 · 48 步 · 昨天", state: "error", group: "昨天", ws: "~/work/pi-harness" },
  { id: "s6", title: "给 CI 加 e2e 冒烟任务", meta: "ds-coder-v3 · 19 步 · 本周一", state: "ok", group: "更早", ws: "~/scratch/spike-otel" },
];

export const DESIGN_TURNS: readonly DesignTurn[] = [
  { kind: "user", text: "支付成功率从昨天上线后掉了很多，日志里全是 3DS challenge timeout。定位一下，能改就直接改，改完跑测试。" },
  { kind: "reasoning", dur: "6s", text: "先找超时配置在哪定义，再看是不是 2.4.0 版本引入的默认值变化。优先只读检索，确认后再动代码。" },
  { kind: "plugin", name: "context-repo-map", hook: "context_provider", text: "注入仓库地图与最近 3 次提交摘要（1,842 tok）" },
  {
    kind: "tool",
    glyph: "⌕",
    name: "grep",
    target: '"3DS" src/**/*.ts',
    dur: "0.4s",
    stat: "12 命中",
    statFg: "#61666B",
    output:
      "src/payment/threeds.ts:41  const CHALLENGE_TIMEOUT_MS = 8_000\nsrc/payment/threeds.ts:88  if (elapsed > CHALLENGE_TIMEOUT_MS) throw new ChallengeTimeout\nsrc/payment/gateway.ts:114  retries: 0\ntest/payment/threeds.spec.ts:23  vi.advanceTimersByTime(8_100)",
  },
  {
    kind: "tool",
    glyph: "▤",
    name: "read",
    target: "src/payment/threeds.ts:30-96",
    dur: "0.1s",
    stat: "66 行",
    statFg: "#61666B",
    output:
      "const CHALLENGE_TIMEOUT_MS = 8_000\n\nexport async function runChallenge(ctx: Ctx) {\n  const started = now()\n  const res = await sdk.challenge(ctx.token)   // sdk 2.4.0\n  const elapsed = now() - started\n  if (elapsed > CHALLENGE_TIMEOUT_MS) throw new ChallengeTimeout()\n  return res\n}",
  },
  {
    kind: "text",
    text: "原因找到了：sdk 2.4.0 起 iOS 端 challenge 平均耗时从 3.1s 涨到 9.4s，而我们的超时仍是 8s，且 retries 为 0，一次超时就直接失败。\n\n我按两处改：超时放宽到 20s，并加一次带抖动的重试。",
  },
  {
    kind: "tool",
    glyph: "✎",
    name: "edit",
    target: "src/payment/threeds.ts",
    dur: "0.2s",
    stat: "+9 −2",
    statFg: "#22C55E",
    isDiff: true,
    diff: [
      { no: "41", sign: "-", text: "const CHALLENGE_TIMEOUT_MS = 8_000" },
      { no: "41", sign: "+", text: "const CHALLENGE_TIMEOUT_MS = 20_000" },
      { no: "42", sign: "+", text: "const CHALLENGE_MAX_ATTEMPTS = 2" },
      { no: "86", sign: "-", text: "  const res = await sdk.challenge(ctx.token)" },
      { no: "86", sign: "+", text: "  const res = await withRetry(CHALLENGE_MAX_ATTEMPTS, () =>" },
      { no: "87", sign: "+", text: "    sdk.challenge(ctx.token), { jitter: true })" },
    ],
  },
  { kind: "plugin", name: "guard-secret-scan", hook: "before_write", text: "改动无凭据外泄风险，放行" },
  { kind: "approval", name: "bash — pnpm vitest run test/payment", text: "cd ~/work/checkout-svc && pnpm vitest run test/payment --reporter=dot" },
  {
    kind: "tool",
    glyph: "$",
    name: "bash",
    target: "pnpm vitest run test/payment",
    dur: "12.4s",
    stat: "exit 0",
    statFg: "#22C55E",
    output:
      "···········\n Test Files  3 passed (3)\n      Tests  27 passed (27)\n   Duration  11.8s\n\n✓ threeds.spec.ts (9)\n✓ gateway.spec.ts (12)\n✓ webhook.spec.ts (6)",
  },
  {
    kind: "subagent",
    name: "reviewer",
    preset: "read-only",
    goal: "复核 threeds.ts 的改动是否引入回归",
    dur: "8.1s",
    lineage: "session #s1 › turn 6 › subagent reviewer（继承 workspace，权限降级为只读）",
    steps: [
      { tool: "read", target: "src/payment/threeds.ts", dur: "0.1s" },
      { tool: "read", target: "src/payment/with-retry.ts", dur: "0.1s" },
      { tool: "grep", target: '"CHALLENGE_TIMEOUT_MS" test/**', dur: "0.3s" },
    ],
    verdict:
      "改动本身正确。两点提醒：test/payment/threeds.spec.ts:23 仍按 8s 断言，会在下次改动时误报通过；withRetry 的抖动上限没设，最坏情况下总耗时可能到 44s，建议加 maxTotalMs。",
  },
  {
    kind: "todo",
    progress: "3 / 4",
    todos: [
      { text: "定位超时来源", done: true },
      { text: "放宽超时并加重试", done: true },
      { text: "跑 payment 相关测试", done: true },
      { text: "补一条针对 20s 边界的回归用例", done: false },
    ],
  },
  {
    kind: "text",
    text: "测试全绿。还剩一条回归用例没补：现有 spec 里 `advanceTimersByTime(8_100)` 断言的是旧阈值，需要改成 20s 边界并新增一条「首次超时后重试成功」的用例。要我继续补吗？",
  },
  { kind: "stats", stats: ["输入 34.2k tok", "缓存命中 61%", "输出 4.8k tok", "用时 1m 42s", "$0.28"] },
];

export const DESIGN_EVENTS: readonly DesignEvent[] = [
  { ts: "02:14:01", source: "system_prompt", summary: "系统提示词组装（preset: coder）", by: "内置", dur: "12ms" },
  { ts: "02:14:01", source: "context_injection", summary: "注入仓库地图与最近提交（1,842 tok）", by: "context-repo-map", dur: "88ms" },
  { ts: "02:14:02", source: "user_message", summary: "支付成功率下降，定位并修复", by: "用户", dur: "—" },
  { ts: "02:14:03", source: "reasoning", summary: "先只读检索超时配置，再判断是否与 sdk 版本相关", by: "ds-coder-v3", dur: "6.0s" },
  { ts: "02:14:09", source: "tool_call", summary: 'grep "3DS" src/**/*.ts', by: "内置", dur: "0.4s" },
  { ts: "02:14:10", source: "tool_result", summary: "12 命中，定位 threeds.ts:41", by: "内置", dur: "—" },
  { ts: "02:14:11", source: "tool_call", summary: "read src/payment/threeds.ts:30-96", by: "内置", dur: "0.1s" },
  { ts: "02:14:14", source: "tool_call", summary: "edit src/payment/threeds.ts (+9 −2)", by: "内置", dur: "0.2s" },
  { ts: "02:14:14", source: "plugin_hook", summary: "凭据扫描通过，放行写入", by: "guard-secret-scan", dur: "31ms" },
  { ts: "02:14:15", source: "approval", summary: "用户允许一次：bash pnpm vitest", by: "用户", dur: "4.2s" },
  { ts: "02:14:19", source: "tool_call", summary: "bash pnpm vitest run test/payment", by: "内置", dur: "12.4s" },
  { ts: "02:14:32", source: "tool_result", summary: "27 passed，exit 0", by: "内置", dur: "—" },
  { ts: "02:14:33", source: "subagent", summary: "派生 reviewer 子代理复核 diff", by: "subagent-review", dur: "8.1s" },
  { ts: "02:14:41", source: "assistant_message", summary: "给出结论与剩余一条回归用例建议", by: "ds-coder-v3", dur: "2.6s" },
];

export const DESIGN_PLUGINS: readonly DesignPlugin[] = [
  {
    name: "context-repo-map",
    ver: "1.4.2",
    capability: "上下文",
    on: true,
    update: false,
    desc: "把仓库结构、入口文件与最近提交压缩成上下文，超预算时自动裁剪",
    hooks: ["context_provider", "before_step"],
  },
  {
    name: "guard-secret-scan",
    ver: "2.0.1",
    capability: "策略",
    on: true,
    update: true,
    desc: "写入与提交前扫描凭据、私钥、token，命中即拦截并说明位置",
    hooks: ["before_write", "before_commit"],
  },
  {
    name: "subagent-review",
    ver: "0.8.5",
    capability: "子代理",
    on: true,
    update: false,
    desc: "改动落盘后派生只读 reviewer 子代理复核 diff，产出可执行意见",
    hooks: ["after_write"],
  },
  {
    name: "sandbox-landlock",
    ver: "1.1.0",
    capability: "沙箱",
    on: true,
    update: false,
    desc: "Linux Landlock 限制子进程可写路径与出网，越权直接拒绝",
    hooks: ["shell_exec"],
  },
  {
    name: "model-deepseek",
    ver: "3.2.0",
    capability: "模型",
    on: true,
    update: true,
    desc: "DeepSeek 官方模型路由，支持 prompt 缓存与推理内容透传",
    hooks: ["model_provider"],
  },
  {
    name: "store-sqlite",
    ver: "1.0.7",
    capability: "存储",
    on: true,
    update: false,
    desc: "会话事件流落地到本地 SQLite，支持 resume、fork、replay",
    hooks: ["session_store"],
  },
  {
    name: "vision-handoff",
    ver: "path",
    capability: "上下文",
    on: true,
    update: false,
    local: true,
    desc: "图片交给独立视觉模型描述后回填上下文，从本地路径加载（../pi-pkg-vision-handoff）",
    hooks: ["context_provider"],
  },
  {
    name: "notify-webhook",
    ver: "0.3.1",
    capability: "通知",
    on: false,
    update: false,
    desc: "任务结束或需要确认时推送到自定义 webhook",
    hooks: ["after_turn"],
  },
];

export const DESIGN_PROVIDERS: readonly DesignProvider[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    state: "已连接",
    ok: true,
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    key: "sk-••••••••••••••••7f3a",
    models: ["ds-coder-v3", "ds-chat", "ds-reasoner"],
    latency: "41ms",
    by: "model-deepseek",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    state: "已连接",
    ok: true,
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    key: "sk-ant-••••••••••2c91",
    models: ["claude-sonnet", "claude-haiku"],
    latency: "128ms",
    by: "model-anthropic",
  },
];

export const DESIGN_TOML = `# ~/.config/pi/pi.toml
# 一切都是包：模型、工具、沙箱、存储、界面都在这里装卸。

[agent]
preset       = "coder"
model        = "ds-coder-v3"
max_steps    = 40
budget_usd   = 1.50
ask_before   = ["write", "shell", "network"]

[sandbox]
backend      = "landlock"
writable     = ["."]
network      = false

[context]
window       = 64000
compact_at   = 0.82

[[packages]]
name = "context-repo-map"
version = "1.4.2"

[[packages]]
name = "guard-secret-scan"
version = "2.0.1"

[[packages]]
name = "subagent-review"
version = "0.8.5"

[[packages]]
path = "../pi-pkg-vision-handoff"   # 本地开发中

[keys]
palette   = "cmd+k"
settings  = "cmd+,"
interrupt = "ctrl+c"
`;
