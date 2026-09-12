import { describe, expect, test, vi } from "vitest";
import {
  MARKETPLACE_CAPABILITIES,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_PLUGINS,
  attachMarketplaceStatistics,
  createMarketplaceStatisticsLoader,
  marketplaceCapabilities,
  marketplaceCategories,
  marketplaceNpmPackageName,
  paginateMarketplace,
  searchMarketplace,
  sortMarketplaceByRecommendation,
} from "../src/marketplace.js";

describe("plugin marketplace registry", () => {
  test("describes reverse skill as text inspection without file loading or activation", () => {
    const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === "reverse-skill");
    expect(plugin?.capabilities).toEqual(["read-only"]);
    expect(plugin?.description).toContain("不读取文件");
    expect(plugin?.description).toContain("不自动激活");
  });

  test("describes the tracked diff reviewer without claiming large-file detection", () => {
    const description = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "reviewer-bot")?.description;
    expect(description).toContain("HEAD");
    expect(description).toContain("已跟踪");
    expect(description).toContain("空白");
    expect(description).toContain("TODO/FIXME");
    expect(description).not.toContain("超大文件");
  });

  test("discloses command execution for the composed change gate", () => {
    const gate = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "change-verifier");
    expect(gate?.capabilities).toContain("runs-commands");
    expect(gate?.capabilities).not.toContain("read-only");
  });

  test.each(MARKETPLACE_PLUGINS)(
    "imports $id from its published package entry point",
    async (plugin) => {
      const entryUrl = import.meta.resolve(plugin.packageName);
      const module = (await import(/* @vite-ignore */ entryUrl)) as { default?: unknown };
      const entry = module.default as { apply?: unknown } | undefined;

      expect(entry).toBeDefined();
      expect(typeof entry?.apply).toBe("function");
    },
    30_000,
  );

  test("contains reviewable, uniquely identified entries", () => {
    expect(MARKETPLACE_PLUGINS.length).toBeGreaterThan(0);
    expect(new Set(MARKETPLACE_PLUGINS.map((plugin) => plugin.id)).size).toBe(MARKETPLACE_PLUGINS.length);
    expect(
      MARKETPLACE_PLUGINS.every((plugin) => plugin.repository.startsWith("https://") && plugin.license && plugin.profile.name === plugin.packageName),
    ).toBe(true);
  });

  test("localizes the English marketplace before filtering and returning it", () => {
    const timer = searchMarketplace("lifecycle-managed asynchronous timers", "", "", "en");

    expect(timer.map((plugin) => plugin.id)).toEqual(["cordis-timer"]);
    expect(timer[0]?.description).toBe("Provide lifecycle-managed asynchronous timers, throttling, and debouncing.");
    expect(timer[0]?.category.label).toBe("Workflow");
    expect(timer[0]?.hooks).toContain("Plugin panel");
    expect(marketplaceCapabilities("en").find((capability) => capability.id === "runs-commands")?.label).toBe("Run local commands");
    expect(marketplaceCategories("en").find((category) => category.id === "security")?.label).toBe("Security");
  });

  test("publishes the high-value official plugins in the same marketplace registry", () => {
    const official = new Map(MARKETPLACE_PLUGINS.filter((plugin) => plugin.source === "official").map((plugin) => [plugin.id, plugin]));
    expect(official.get("agent-teams")?.category.id).toBe("workflow");
    expect(official.get("plugin-stars")?.category.id).toBe("discovery");
    expect(official.get("plugin-stars")?.description).toMatch(/显式配置.*raw\.githubusercontent\.com.*失败保留/u);
    expect(official.get("plugin-stars")?.capabilities).toEqual(["network-access"]);
    expect(official.get("plugin-stars")?.hooks).toEqual(["榜单搜索工具", "GitHub 原始快照", "插件面板"]);
    expect(official.get("plugin-stars")?.profile.config).toEqual({
      limit: 10,
      timeoutMs: 15_000,
    });
    expect(official.get("vision-toolkit")?.category.id).toBe("multimodal");
    expect(official.get("vision-toolkit")?.description).toMatch(/PNG.*JPEG.*GIF.*WebP.*只读文件头.*可取消.*本机/u);
    expect(official.get("vision-toolkit")?.capabilities).toEqual(["read-only", "reads-files"]);
    expect(official.get("vision-toolkit")?.hooks).toEqual(["图像元数据工具", "工作区访问", "插件面板"]);
    expect(official.get("vision-toolkit")?.profile.config).toEqual({});
    expect(official.get("session-bridge")?.category.id).toBe("workflow");
    expect(official.get("plugin-radar")?.description).toContain("GitHub");
    expect(official.get("plugin-radar")?.description).toContain("未验证可安装性");
    expect(official.get("plugin-radar")?.hooks).toEqual(["GitHub Topic 搜索", "插件面板"]);
    expect(official.get("session-bridge")?.description).toMatch(/预览.*导出.*导入需要确认.*严格校验.*防重复注入/u);
    expect(official.get("session-bridge")?.capabilities).toEqual(["session-data", "writes-files"]);
    expect(official.get("session-bridge")?.hooks).toEqual(["会话桥接工具", "当前会话管理器", "自定义上下文消息", "插件面板"]);
    expect(official.get("session-bridge")?.profile.config).toEqual({});
    expect(official.get("skill-guard")?.category.id).toBe("security");
    expect(official.get("skill-guard")?.description).toMatch(/启发式.*已加载 Skill.*不会停用/u);
    expect(official.get("skill-guard")?.capabilities).toEqual(["read-only", "reads-files"]);
    expect(official.get("skill-guard")?.hooks).toEqual(["skill 扫描工具", "资源加载器", "插件面板"]);
    expect(official.get("skill-guard")?.profile.config).toEqual({});
    expect(official.get("cost-meter")?.category.id).toBe("observability");
    expect(official.get("cost-meter")?.description).toMatch(/运行时上报的费用.*UTC.*本地账本/u);
    expect(official.get("cost-meter")?.capabilities).toEqual(["session-data", "reads-files", "writes-files"]);
    expect(official.get("cost-meter")?.hooks).toEqual(["运行结束", "费用报告工具", "插件面板"]);
    expect(official.get("cost-meter")?.profile.config).toEqual({ dailyBudget: 0, maxEntries: 365 });
    expect(official.get("skill-catalog")?.category.id).toBe("discovery");
    expect(official.get("prompt-guard")?.category.id).toBe("security");
    expect(official.get("browser-fetch")?.category.id).toBe("web");
    expect(official.get("browser-fetch")?.description).toMatch(/有上限的文本.*固定 DNS.*内网.*文本类型.*可取消.*超时/u);
    expect(official.get("browser-fetch")?.capabilities).toEqual(["network-access"]);
    expect(official.get("browser-fetch")?.profile.config).toEqual({ allowPrivate: false, timeoutMs: 20_000 });
    expect(official.get("web-research")?.category.id).toBe("web");
    expect(official.get("mcp-client")?.category.id).toBe("developer");
    expect(official.get("mcp-client")?.description).toMatch(/MCP stdio.*工具、资源与提示词.*可取消.*生命周期/u);
    expect(official.get("mcp-client")?.capabilities).toEqual(["runs-commands"]);
    expect(official.get("mcp-client")?.hooks).toEqual(["MCP stdio 工具", "托管服务进程", "插件面板"]);
    expect(official.get("mcp-client")?.profile.config).toEqual({ servers: [] });
    expect(official.get("at-file")?.category.id).toBe("context");
    expect(official.get("at-file")?.description).toMatch(/256 KiB.*UTF-8.*只读上下文.*工作区内.*符号链接/u);
    expect(official.get("at-file")?.capabilities).toEqual(["read-only", "reads-files"]);
    expect(official.get("at-file")?.hooks).toEqual(["文件上下文工具", "工作区文件读取", "插件面板"]);
    expect(official.get("at-file")?.profile.config).toEqual({});
    expect(official.get("dependency-checker")?.category.id).toBe("developer");
    expect(official.get("dependency-checker")?.description).toMatch(/离线.*只读.*package\.json.*requirements.*已安装.*约束/u);
    expect(official.get("dependency-checker")?.capabilities).toEqual(["read-only", "reads-files"]);
    expect(official.get("dependency-checker")?.hooks).toEqual(["依赖检查工具", "工作区清单读取", "插件面板"]);
    expect(official.get("token-guard")?.category.id).toBe("observability");
    expect(official.get("token-guard")?.description).toMatch(/上下文占比.*计费 token.*一次运行最多发出一次中止.*缓存/u);
    expect(official.get("token-guard")?.capabilities).toEqual(["read-only", "session-data"]);
    expect(official.get("token-guard")?.hooks).toEqual(["Pi 会话生命周期", "当前运行中止", "会话用量与统计", "插件面板"]);
    expect(official.get("token-guard")?.profile.config).toEqual({ maxPercent: 90, maxRunTokens: 0 });
    expect(official.get("recall-unread")?.category.id).toBe("workflow");
    expect(official.get("recall-unread")?.description).toMatch(/只读.*当前工作区.*还没被回复.*缓存/u);
    expect(official.get("recall-unread")?.capabilities).toEqual(["read-only", "session-data", "reads-files"]);
    expect(official.get("recall-unread")?.hooks).toEqual(["未读回溯工具", "原生会话存储", "当前会话管理器", "插件面板"]);
    expect(official.get("recall-unread")?.profile.config).toEqual({});
    expect(official.get("turn-rewind")?.category.id).toBe("workflow");
    expect(official.get("turn-rewind")?.description).toMatch(/当前分支.*agent 空闲.*串行回退.*原生会话树/u);
    expect(official.get("turn-rewind")?.capabilities).toEqual(["read-only", "session-data"]);
    expect(official.get("turn-rewind")?.hooks).toEqual(["会话回退工具", "当前会话树", "agent 空闲生命周期", "插件面板"]);
    expect(official.get("turn-rewind")?.profile.config).toEqual({});
    expect(official.get("context-doctor")?.category.id).toBe("observability");
    expect(official.get("history-compressor")?.category.id).toBe("context");
    expect(official.get("reviewer-bot")?.category.id).toBe("workflow");
    expect(official.get("auto-mode")?.category.id).toBe("security");
    expect(official.get("plan-execute")?.category.id).toBe("workflow");
    expect(official.get("plan-execute")?.capabilities).toEqual(["session-data", "writes-files"]);
    expect(official.get("plan-execute")?.description).toMatch(/保存.*恢复/u);
    expect(official.get("canvas-draw")?.category.id).toBe("multimodal");
    expect(official.get("canvas-draw")?.description).toMatch(/Mermaid 流程图源码/u);
    expect(official.get("canvas-draw")?.hooks).toEqual(["插件面板"]);
    expect(official.get("image-compressor")?.category.id).toBe("multimodal");
    expect(official.get("code2skill")?.category.id).toBe("developer");
    expect(official.get("code2skill")?.description).toMatch(/选中的工作区源码/u);
    expect(official.get("code2skill")?.capabilities).toEqual(["reads-files", "writes-files"]);
    expect(official.get("workspace-search")?.category.id).toBe("context");
    expect(official.get("plugin-check")?.category.id).toBe("security");
    expect(official.get("test-harness")?.category.id).toBe("developer");
    expect(official.get("test-harness")?.description).toMatch(/五个固定名字的 npm 脚本.*12 KiB.*超时.*取消.*进程树/u);
    expect(official.get("test-harness")?.capabilities).toEqual(["runs-commands"]);
    expect(official.get("test-harness")?.hooks).toEqual(["项目验证工具", "工作区 npm 脚本", "插件面板"]);
    expect(official.get("test-harness")?.profile.config).toEqual({ timeoutMs: 120_000 });
    expect(official.get("git-time-capsule")?.category.id).toBe("workflow");
    expect(official.get("git-time-capsule")?.description).toMatch(/未暂存的 Git 改动.*逐字节.*确认后.*反向应用/u);
    expect(official.get("git-time-capsule")?.capabilities).toEqual(["reads-files", "writes-files", "runs-commands"]);
    expect(official.get("git-time-capsule")?.hooks).toEqual(["Git 快照工具", "Git 还原工具", "插件面板"]);
    expect(official.get("git-time-capsule")?.profile.config).toEqual({ timeoutMs: 15_000 });
    expect(official.get("graph-memory")?.description).toMatch(/带类型的节点.*有向关系.*加锁.*跨会话/u);
    expect(official.get("graph-memory")?.capabilities).toEqual(["reads-files", "writes-files"]);
    expect(official.get("graph-memory")?.hooks).toEqual(["图记忆工具", "本地图文件", "插件面板"]);
    expect(official.get("graph-memory")?.profile.config).toEqual({ fileName: "graph-memory.json", maxNodes: 2_000, maxRelations: 5_000 });
    expect(official.get("yaml-validator")?.category.id).toBe("developer");
    expect(official.get("yaml-validator")?.description).toMatch(/工作区内.*UTF-8.*多文档 YAML.*受限.*可取消/u);
    expect(official.get("yaml-validator")?.capabilities).toEqual(["read-only", "reads-files"]);
    expect(official.get("yaml-validator")?.hooks).toEqual(["YAML 校验工具", "工作区文件", "插件面板"]);
    expect(official.get("yaml-validator")?.profile.config).toEqual({});
    expect(official.get("browser-session")?.category.id).toBe("web");
    expect(official.get("browser-session")?.category).toEqual(official.get("browser-fetch")?.category);
    expect(official.get("browser-session")?.description).toMatch(/本机回环.*命令受限.*可取消.*截图元数据/u);
    expect(official.get("browser-session")?.capabilities).toEqual(["network-access"]);
    expect(official.get("browser-session")?.hooks).toEqual(["浏览器会话工具", "Chrome DevTools 协议", "插件面板"]);
    expect(official.get("browser-session")?.profile.config).toEqual({ endpoint: "http://127.0.0.1:9222" });
    expect(official.get("docker-sandbox")?.category.id).toBe("security");
    expect(official.get("docker-sandbox")?.description).toMatch(/本地镜像.*无网络.*只读.*CPU.*内存.*进程数.*输出会清理.*取消/u);
    expect(official.get("docker-sandbox")?.capabilities).toEqual(["reads-files", "writes-files", "runs-commands"]);
    expect(official.get("docker-sandbox")?.hooks).toEqual(["沙箱执行工具", "Docker CLI", "插件面板"]);
    expect(official.get("docker-sandbox")?.profile.config).toEqual({});
    expect(official.get("mock-server")?.category.id).toBe("developer");
    expect(official.get("sql-lens")?.category.id).toBe("developer");
    expect(official.get("sql-lens")?.description).toMatch(/SQLite.*一次一条只读语句.*有上限.*符号链接.*超时.*取消/u);
    expect(official.get("sql-lens")?.capabilities).toEqual(["reads-files", "runs-commands"]);
    expect(official.get("sql-lens")?.hooks).toEqual(["SQL 只读工具", "工作区 SQLite 文件", "插件面板"]);
    expect(official.get("sql-lens")?.profile.config).toEqual({ timeoutMs: 5_000 });
    expect(official.get("i18n-pair")?.category.id).toBe("workflow");
    expect(official.get("i18n-pair")?.description).toMatch(/只读.*JSON 语言文件.*缺失键.*多余键.*符号链接.*可取消/u);
    expect(official.get("i18n-pair")?.capabilities).toEqual(["read-only", "reads-files"]);
    expect(official.get("i18n-pair")?.hooks).toEqual(["i18n 检查工具", "工作区语言文件", "插件面板"]);
    expect(official.get("i18n-pair")?.profile.config).toEqual({});
    expect(official.get("plugin-finder")?.category.id).toBe("discovery");
    expect(official.get("readme-gen")?.category.id).toBe("developer");
    expect(official.get("readme-gen")?.description).toMatch(/依赖清单.*加载器清单.*Markdown 转义.*不覆盖.*显式确认/u);
    expect(official.get("readme-gen")?.capabilities).toEqual(["reads-files", "writes-files"]);
    expect(official.get("readme-gen")?.hooks).toEqual(["README 报告与写入工具", "工作区清单与文件", "Cordis 加载器清单", "插件面板"]);
    expect(official.get("readme-gen")?.profile.config).toEqual({});
    expect(official.get("anchored-standard")?.category.id).toBe("security");
    expect(official.get("annotation")?.hooks).toEqual(["插件面板"]);
    expect(official.get("change-verifier")?.category.id).toBe("workflow");
    expect(official.get("openpets")?.category.id).toBe("web");
    expect(official.get("openpets")?.description).toMatch(/会话事件.*不保存消息内容.*操作受限.*持久化状态/u);
    expect(official.get("openpets")?.capabilities).toEqual(["read-only", "session-data"]);
    expect(official.get("openpets")?.hooks).toEqual(["会话事件", "宠物反应工具", "会话存储", "插件面板"]);
    expect(official.get("openpets")?.profile.config).toEqual({});
    expect(official.get("session-insights")?.category.id).toBe("observability");
    expect(official.get("session-insights")?.description).toMatch(/校验.*缓存.*会话空闲.*确认.*用量.*费用.*可取消/u);
    expect(official.get("session-insights")?.capabilities).toEqual(["read-only", "session-data"]);
    expect(official.get("session-insights")?.hooks).toEqual(["会话报告工具", "当前运行会话", "Pi 会话生命周期", "插件面板"]);
    expect(official.get("session-insights")?.profile.config).toEqual({});
    expect(official.get("mcp-panel")?.category.id).toBe("developer");
    expect(official.get("fail-logger")?.category.id).toBe("observability");
    expect(official.get("fail-logger")?.description).toMatch(/插件错误.*agent 失败.*压缩失败.*摘要.*次数.*不留原始载荷/u);
    expect(official.get("fail-logger")?.capabilities).toEqual(["read-only"]);
    expect(official.get("fail-logger")?.hooks).toEqual(["插件错误", "运行结束", "压缩结束", "插件面板"]);
    expect(official.get("genui")?.description).toMatch(/文本、标签和进度条.*纯文本/u);
    expect(official.get("genui")?.capabilities).toEqual(["read-only"]);
    expect(official.get("telemetry-blocker")?.description).toContain("不拦截网络流量");
    expect(official.get("telemetry-blocker")?.hooks).toEqual(["本地遥测服务", "事件总线观察", "插件面板"]);
    expect(official.get("genui")?.hooks).toEqual(["GenUI 渲染工具", "插件面板"]);
    expect(official.get("plugin-dev")?.category.id).toBe("developer");
    expect(official.get("plugin-dev")?.description).toMatch(/推迟.*agent 空闲.*只允许一个重载.*本机开发/u);
    expect(official.get("plugin-dev")?.capabilities).toEqual(["read-only", "session-data"]);
    expect(official.get("plugin-dev")?.hooks).toEqual(["会话资源重载工具", "Pi 会话生命周期", "插件面板"]);
    expect(official.get("plugin-dev")?.profile.config).toEqual({});
    expect(official.get("session-export")?.category.id).toBe("workflow");
    expect(official.get("session-search")?.category.id).toBe("discovery");
    expect(official.get("session-compare")?.category.id).toBe("discovery");
    expect(official.get("secure-audit")?.category.id).toBe("security");
    expect(official.get("session-bookmarks")?.category.id).toBe("workflow");
    expect(official.get("llm-verifier")?.category.id).toBe("developer");
    expect(official.get("module-search")?.category.id).toBe("discovery");
    expect(official.get("workspace-navigator")?.category.id).toBe("developer");
    expect(official.get("reverse-skill")?.category.id).toBe("security");
    expect(official.get("colleague-skill")?.category.id).toBe("workflow");
    expect(official.get("colleague-skill")?.hooks).toEqual(["会话存储", "插件面板"]);
    expect(official.get("context-insights")?.category.id).toBe("context");
    expect(official.get("context-insights")?.description).toMatch(/上下文占用.*消息构成.*缓存.*会话计数.*上限/u);
    expect(official.get("context-insights")?.capabilities).toEqual(["read-only", "session-data"]);
    expect(official.get("context-insights")?.hooks).toEqual(["上下文检查工具", "当前运行会话", "Pi 会话生命周期", "插件面板"]);
    expect(official.get("context-insights")?.profile.config).toEqual({});
    expect(official.get("context-doctor")?.category.id).toBe("observability");
    expect(official.get("context-doctor")?.description).toMatch(/压力来源.*工具报错.*排到 agent 空闲.*确认后.*费用.*可取消/u);
    expect(official.get("context-doctor")?.capabilities).toEqual(["read-only", "session-data"]);
    expect(official.get("context-doctor")?.hooks).toEqual(["上下文体检工具", "会话消息与用量", "Pi 会话生命周期", "手动压缩", "插件面板"]);
    expect(official.get("context-doctor")?.profile.config).toEqual({});
    expect(official.get("cordis-group")?.category.id).toBe("workflow");
    expect(official.get("cordis-group")?.capabilities).toEqual(["read-only"]);
    expect(official.get("cordis-group")?.hooks).toEqual(["加载器条目树"]);
    expect(official.get("cordis-logger-console")?.category.id).toBe("observability");
    expect(official.get("cordis-logger-console")?.capabilities).toEqual(["read-only"]);
    expect(official.get("cordis-logger-console")?.hooks).toEqual(["Cordis 日志导出", "插件面板"]);
    expect(official.get("cordis-logger-console")?.profile.config).toEqual({ levels: { default: 2 }, maxLength: 8_192 });
    expect(official.get("cordis-timer")?.category.id).toBe("workflow");
    expect(official.get("cordis-timer")?.capabilities).toEqual(["read-only"]);
    expect(official.get("cordis-timer")?.hooks).toEqual(["Cordis 定时服务", "插件面板"]);
    expect(official.get("prompt-library")?.category.id).toBe("workflow");
    expect(official.get("cleaner")?.category.id).toBe("developer");
    expect(official.get("cleaner")?.description).toMatch(/Git 胶囊.*保留策略.*显式确认.*符号链接.*文件替换.*可取消/u);
    expect(official.get("cleaner")?.capabilities).toEqual(["reads-files", "writes-files"]);
    expect(official.get("cleaner")?.hooks).toEqual(["胶囊清理工具", "agent 胶囊目录", "插件面板"]);
    expect(official.get("cleaner")?.profile.config).toEqual({});
    expect(official.get("cli-notifier")?.category.id).toBe("workflow");
    expect(official.get("cli-notifier")?.description).toMatch(/本机桌面通知/u);
    expect(official.get("cli-notifier")?.description).not.toMatch(/webhook/iu);
    expect(official.get("cli-notifier")?.capabilities).toEqual(["runs-commands"]);
    expect(official.get("cli-notifier")?.hooks).toEqual(["运行结束", "压缩失败", "插件面板"]);
    expect(official.get("obsidian-sync")?.category.id).toBe("workflow");
    expect(official.get("tab-manager")?.category.id).toBe("workflow");
    expect(official.get("telemetry-blocker")?.category.id).toBe("security");
    expect(official.get("runtime-doctor")?.category.id).toBe("developer");
    expect(official.get("better-sidebar")?.category.id).toBe("interface");
  });

  test("lists every plugin as an installable npm package rather than a launcher subpath", () => {
    const subpaths = MARKETPLACE_PLUGINS.filter((plugin) => plugin.packageName.includes("/plugins/"));
    expect(subpaths).toEqual([]);
    expect(MARKETPLACE_PLUGINS.every((plugin) => marketplaceNpmPackageName(plugin.packageName) === plugin.packageName)).toBe(true);
    expect(MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "skill-guard")?.packageName).toBe("@pi-harness/plugin-skill-guard");
  });

  test("filters by query and capability without mutating the registry", () => {
    const result = searchMarketplace("timer", "read-only");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(searchMarketplace("does-not-exist")).toEqual([]);
    expect(MARKETPLACE_PLUGINS.length).toBeGreaterThan(3);
  });

  test("filters by a declared category independently from capabilities", () => {
    const result = searchMarketplace("timer", "", "workflow");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(result[0]?.category).toEqual({ id: "workflow", label: "工作流" });
    expect(MARKETPLACE_CATEGORIES).toEqual(expect.arrayContaining([{ id: "workflow", label: "工作流", count: 20 }]));
    // A tab that holds a single plugin is a tab nobody clicks, and the filter is only worth its width if each option narrows the list to something worth reading.
    expect(MARKETPLACE_CATEGORIES.every((category) => category.count > 1)).toBe(true);
  });

  test("loads one entry per file and paginates the filtered result", () => {
    const page = paginateMarketplace(searchMarketplace(), 1, 2);
    expect(page).toEqual({
      items: MARKETPLACE_PLUGINS.slice(2, 4),
      total: MARKETPLACE_PLUGINS.length,
      page: 1,
      pageSize: 2,
      hasNext: MARKETPLACE_PLUGINS.length > 4,
    });
  });

  // The filter is the first thing a reader touches before installing anything, so what it offers has to be a fixed set that says what a plugin does to the machine, and every entry has to answer it.
  test("describes every entry with the same closed capability vocabulary", () => {
    const vocabulary = MARKETPLACE_CAPABILITIES.map((capability) => capability.id);
    expect(vocabulary).toEqual(["read-only", "session-data", "reads-files", "writes-files", "runs-commands", "local-server", "network-access", "model-calls"]);
    expect(MARKETPLACE_CAPABILITIES.every((capability) => capability.label !== "" && capability.count > 0)).toBe(true);
    expect(MARKETPLACE_CAPABILITIES.reduce((sum, capability) => sum + capability.count, 0)).toBe(
      MARKETPLACE_PLUGINS.reduce((sum, plugin) => sum + plugin.capabilities.length, 0),
    );
    for (const plugin of MARKETPLACE_PLUGINS) {
      expect(plugin.capabilities.length).toBeGreaterThan(0);
      expect(plugin.capabilities.filter((capability) => vocabulary.includes(capability))).toEqual(plugin.capabilities);
      expect(new Set(plugin.capabilities).size).toBe(plugin.capabilities.length);
      // A plugin that says it changes nothing cannot also say it writes, executes, listens, dials out, or spends money.
      if (plugin.capabilities.includes("read-only"))
        expect(
          plugin.capabilities.some((capability) => ["writes-files", "runs-commands", "local-server", "network-access", "model-calls"].includes(capability)),
        ).toBe(false);
    }
  });

  // The tabs take their label from whichever entry happens to be read first, so two spellings of one category would make the console's own vocabulary depend on file order.
  test("spells each category the same way in every entry", () => {
    const labels = new Map<string, string>();
    for (const plugin of MARKETPLACE_PLUGINS) {
      expect(labels.get(plugin.category.id) ?? plugin.category.label).toBe(plugin.category.label);
      labels.set(plugin.category.id, plugin.category.label);
    }
    expect(labels.size).toBe(MARKETPLACE_CATEGORIES.length);
  });

  // The ids are what the filter and the URL carry, and the labels are what the reader sees, so a search for either has to find the same plugin.
  test("finds a plugin by a capability id and by its label", () => {
    const byId = searchMarketplace("local-server");
    expect(byId.map((plugin) => plugin.id)).toEqual(["mock-server"]);
    expect(searchMarketplace("监听本地端口").map((plugin) => plugin.id)).toEqual(["mock-server"]);
    expect(searchMarketplace("", "local-server").map((plugin) => plugin.id)).toEqual(["mock-server"]);
  });

  test("maps plugin entry points to their published npm package", () => {
    expect(marketplaceNpmPackageName("@pi-harness/plugin-agent-teams")).toBe("@pi-harness/plugin-agent-teams");
    expect(marketplaceNpmPackageName("@example-scope/toolkit/plugins/subpath")).toBe("@example-scope/toolkit");
    expect(marketplaceNpmPackageName("@deepseek-ai/cordis-plugin-timer")).toBe("@deepseek-ai/cordis-plugin-timer");
    expect(marketplaceNpmPackageName("unscoped-package/runtime")).toBe("unscoped-package");
  });

  test("loads and caches npm marketplace statistics without treating unpublished packages as zero-download packages", async () => {
    const requests: string[] = [];
    const fetcher = (url: string): Promise<Response> => {
      requests.push(url);
      if (url.startsWith("https://registry.npmjs.org/-/v1/search")) {
        const name = new URL(url).searchParams.get("text");
        const objects =
          name === "@deepseek-ai/cordis-plugin-timer"
            ? [
                {
                  package: {
                    name,
                    scope: "deepseek-ai",
                    version: "1.1.4",
                    description: "Cordis timer service",
                    keywords: ["cordis", "timer"],
                    date: "2026-08-30T13:14:00.557Z",
                    links: { npm: "https://www.npmjs.com/package/@deepseek-ai/cordis-plugin-timer" },
                    publisher: { username: "deepseek-ai", email: "opensource@deepseek.com" },
                    maintainers: [{ username: "deepseek-ai", email: "opensource@deepseek.com" }],
                  },
                  score: { final: 0.95, detail: { quality: 0.92, popularity: 0.98, maintenance: 0.96 } },
                  searchScore: 100000.95,
                },
              ]
            : [];
        return Promise.resolve(Response.json({ objects, total: objects.length, time: "2026-09-03T00:00:00.000Z" }));
      }
      if (url === "https://api.npmjs.org/downloads/point/last-month/%40deepseek-ai%2Fcordis-plugin-timer") {
        return Promise.resolve(Response.json({ downloads: 1_014_632, start: "2026-07-31", end: "2026-08-29", package: "@deepseek-ai/cordis-plugin-timer" }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
    const load = createMarketplaceStatisticsLoader({ fetcher, now: () => 1_000, ttlMs: 60_000 });
    const plugins = MARKETPLACE_PLUGINS.filter((plugin) => plugin.id === "agent-teams" || plugin.id === "cordis-timer");

    const first = await load(plugins);
    const second = await load(plugins);

    expect(first.get("@deepseek-ai/cordis-plugin-timer")).toEqual({ downloads30d: 1_014_632, quality: 0.92, updatedAt: "2026-08-30T13:14:00.557Z" });
    expect(first.has("@pi-harness/core")).toBe(false);
    expect(second).toEqual(first);
    expect(requests).toHaveLength(3);
  });

  test("keeps successful package statistics cached while retrying only failed packages", async () => {
    let timestamp = 1_000;
    let flakyAvailable = false;
    const requests = new Map<string, number>();
    const fetcher = (url: string): Promise<Response> => {
      const parsed = new URL(url);
      const packageName = parsed.hostname === "registry.npmjs.org" ? parsed.searchParams.get("text")! : decodeURIComponent(parsed.pathname.split("/").at(-1)!);
      requests.set(packageName, (requests.get(packageName) ?? 0) + 1);
      if (packageName === "flaky-package" && !flakyAvailable) throw new Error("temporary npm failure");
      if (parsed.hostname === "registry.npmjs.org") {
        return Promise.resolve(
          Response.json({
            objects: [{ package: { name: packageName, date: "2026-09-01T00:00:00.000Z" }, score: { detail: { quality: 0.9 } } }],
          }),
        );
      }
      return Promise.resolve(Response.json({ downloads: packageName === "stable-package" ? 100 : 10 }));
    };
    const base = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "cordis-timer")!;
    const plugins = [
      { ...base, id: "stable", packageName: "stable-package" },
      { ...base, id: "flaky", packageName: "flaky-package" },
    ];
    const load = createMarketplaceStatisticsLoader({ fetcher, now: () => timestamp, ttlMs: 10_000, failureTtlMs: 100 });

    await load(plugins);
    flakyAvailable = true;
    timestamp += 101;
    const retried = await load(plugins);

    expect(retried.get("stable-package")?.downloads30d).toBe(100);
    expect(retried.get("flaky-package")?.downloads30d).toBe(10);
    expect(requests.get("stable-package")).toBe(2);
    expect(requests.get("flaky-package")).toBe(3);
  });

  test("keeps partial npm statistics when the download endpoint is unavailable", async () => {
    const fetcher = (url: string): Promise<Response> => {
      if (url.startsWith("https://registry.npmjs.org/-/v1/search")) {
        const name = new URL(url).searchParams.get("text");
        return Promise.resolve(
          Response.json({
            objects: [
              {
                package: { name, version: "1.1.4", date: "2026-08-30T13:14:00.557Z" },
                score: { final: 0.9, detail: { quality: 0.8, popularity: 0.9, maintenance: 1 } },
                searchScore: 100000.9,
              },
            ],
            total: 1,
            time: "2026-09-03T00:00:00.000Z",
          }),
        );
      }
      throw new Error("npm downloads unavailable");
    };
    const load = createMarketplaceStatisticsLoader({ fetcher });
    const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === "cordis-timer")!;

    await expect(load([plugin])).resolves.toEqual(new Map([["@deepseek-ai/cordis-plugin-timer", { quality: 0.8, updatedAt: "2026-08-30T13:14:00.557Z" }]]));
  });

  test("retries npm statistics after a short failure cache expires", async () => {
    let available = false;
    let timestamp = 1_000;
    let requests = 0;
    const fetcher = (url: string): Promise<Response> => {
      requests += 1;
      if (!available) throw new Error("npm unavailable");
      if (url.startsWith("https://registry.npmjs.org/-/v1/search")) {
        return Promise.resolve(
          Response.json({
            objects: [
              {
                package: { name: "@deepseek-ai/cordis-plugin-timer", version: "1.1.4", date: "2026-08-30T13:14:00.557Z" },
                score: { final: 0.9, detail: { quality: 0.9, popularity: 0.9, maintenance: 0.9 } },
                searchScore: 100000.9,
              },
            ],
            total: 1,
            time: "2026-09-03T00:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({ downloads: 1_000, start: "2026-07-31", end: "2026-08-29", package: "@deepseek-ai/cordis-plugin-timer" }));
    };
    const load = createMarketplaceStatisticsLoader({ fetcher, now: () => timestamp, ttlMs: 60_000, failureTtlMs: 100 });
    const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === "cordis-timer")!;

    await expect(load([plugin])).resolves.toEqual(new Map());
    available = true;
    timestamp += 50;
    await expect(load([plugin])).resolves.toEqual(new Map());
    timestamp += 51;
    await expect(load([plugin])).resolves.toEqual(
      new Map([["@deepseek-ai/cordis-plugin-timer", { downloads30d: 1_000, quality: 0.9, updatedAt: "2026-08-30T13:14:00.557Z" }]]),
    );
    expect(requests).toBe(3);
  });

  test("serves the statistics already cached and warms the missing ones in the background", async () => {
    const requests: string[] = [];
    const fetcher = (url: string): Promise<Response> => {
      requests.push(url);
      if (url.startsWith("https://registry.npmjs.org/-/v1/search"))
        return Promise.resolve(
          Response.json({
            objects: [
              {
                package: { name: new URL(url).searchParams.get("text"), date: "2026-08-30T13:14:00.557Z" },
                score: { detail: { quality: 0.9 } },
              },
            ],
          }),
        );
      return Promise.resolve(Response.json({ downloads: 4_200 }));
    };
    const load = createMarketplaceStatisticsLoader({ fetcher, ttlMs: 60_000 });
    const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === "cordis-timer")!;

    expect(load.readCached([plugin])).toEqual({ ready: false, statistics: new Map() });
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    expect(load.readCached([plugin])).toEqual({
      ready: true,
      statistics: new Map([["@deepseek-ai/cordis-plugin-timer", { downloads30d: 4_200, quality: 0.9, updatedAt: "2026-08-30T13:14:00.557Z" }]]),
    });
    expect(requests).toHaveLength(2);
  });

  test("stays ready once a lookup has expired so the catalogue is not reordered back to its unsorted form mid-session", async () => {
    let timestamp = 1_000;
    const fetcher = (url: string): Promise<Response> => {
      if (url.startsWith("https://registry.npmjs.org/-/v1/search"))
        return Promise.resolve(Response.json({ objects: [{ package: { name: "@deepseek-ai/cordis-plugin-timer" }, score: { detail: { quality: 0.5 } } }] }));
      return Promise.resolve(Response.json({ downloads: 10 }));
    };
    const load = createMarketplaceStatisticsLoader({ fetcher, now: () => timestamp, ttlMs: 100 });
    const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === "cordis-timer")!;

    await load([plugin]);
    timestamp += 101;

    // The entry is stale and is refreshed in the background, but it has been looked up, so the caller keeps sorting on statistics instead of dropping the whole grid back to catalogue order for one poll.
    const cached = load.readCached([plugin]);
    expect(cached.ready).toBe(true);
    expect(cached.statistics.size).toBe(0);
  });

  test("keeps the npm fan-out below the configured concurrency instead of asking for every package at once", async () => {
    let active = 0;
    let peak = 0;
    const fetcher = async (): Promise<Response> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return Response.json({ objects: [] });
    };
    const base = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "cordis-timer")!;
    const plugins = Array.from({ length: 12 }, (_, index) => ({ ...base, id: `bulk-${index}`, packageName: `bulk-package-${index}` }));
    const load = createMarketplaceStatisticsLoader({ concurrency: 3, fetcher });

    await load(plugins);

    expect(peak).toBe(3);
  });

  test("backs off further on every consecutive npm failure so an open console stops re-issuing the same lookups", async () => {
    let timestamp = 1_000;
    let requests = 0;
    const fetcher = (): Promise<Response> => {
      requests += 1;
      throw new Error("npm unavailable");
    };
    const load = createMarketplaceStatisticsLoader({ failureMaxTtlMs: 400, failureTtlMs: 100, fetcher, now: () => timestamp });
    const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === "cordis-timer")!;

    await load([plugin]);
    timestamp += 101;
    await load([plugin]);
    expect(requests).toBe(2);

    // The second failure doubles the retry window, so the poll that would have retried under a flat window finds the cache still valid.
    timestamp += 101;
    await load([plugin]);
    expect(requests).toBe(2);

    timestamp += 100;
    await load([plugin]);
    expect(requests).toBe(3);

    // The window is capped rather than doubling forever, so the package is retried again once the ceiling elapses.
    timestamp += 401;
    await load([plugin]);
    expect(requests).toBe(4);
  });

  test("sorts recommendations before pagination using verification, npm quality, downloads and recency", () => {
    const base = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "cordis-timer")!;
    const plugins = [
      { ...base, id: "older-popular", name: "Older popular", packageName: "older-popular", status: "verified" as const },
      { ...base, id: "recent-quality", name: "Recent quality", packageName: "recent-quality", status: "verified" as const },
      { ...base, id: "experimental", name: "Experimental", packageName: "experimental", status: "experimental" as const },
    ];
    const statistics = new Map([
      ["older-popular", { downloads30d: 1_000_000, quality: 0.8, updatedAt: "2025-09-03T00:00:00.000Z" }],
      ["recent-quality", { downloads30d: 100_000, quality: 0.95, updatedAt: "2026-09-01T00:00:00.000Z" }],
      ["experimental", { downloads30d: 10_000_000, quality: 1, updatedAt: "2026-09-03T00:00:00.000Z" }],
    ]);

    const ranked = sortMarketplaceByRecommendation(attachMarketplaceStatistics(plugins, statistics), Date.parse("2026-09-03T00:00:00.000Z"));
    const page = paginateMarketplace(ranked, 0, 2);

    expect(ranked.map((plugin) => plugin.id)).toEqual(["recent-quality", "older-popular", "experimental"]);
    expect(page.items.map((plugin) => plugin.id)).toEqual(["recent-quality", "older-popular"]);
    expect(ranked[0]?.statistics).toEqual(statistics.get("recent-quality"));
  });
});
