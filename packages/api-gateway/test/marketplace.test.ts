import { describe, expect, test, vi } from "vitest";
import {
  MARKETPLACE_CAPABILITIES,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_PLUGINS,
  attachMarketplaceStatistics,
  createMarketplaceStatisticsLoader,
  marketplaceNpmPackageName,
  paginateMarketplace,
  searchMarketplace,
  sortMarketplaceByRecommendation,
} from "../src/marketplace.js";

describe("plugin marketplace registry", () => {
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

  test("publishes the high-value official plugins in the same marketplace registry", () => {
    const official = new Map(MARKETPLACE_PLUGINS.filter((plugin) => plugin.source === "official").map((plugin) => [plugin.id, plugin]));
    expect(official.get("agent-teams")?.category.id).toBe("collaboration");
    expect(official.get("plugin-stars")?.category.id).toBe("discovery");
    expect(official.get("plugin-stars")?.description).toMatch(
      /curated.*raw\.githubusercontent\.com.*descriptor-safe.*bounded.*cancellable.*fail-closed.*panel/iu,
    );
    expect(official.get("plugin-stars")?.capabilities).toEqual([
      "curated GitHub ranking search",
      "strict bounded snapshot validation",
      "redirect-free source fetch",
      "cancellable request lifecycle",
      "bounded panel inventory",
      "validated fail-closed panel reporting",
    ]);
    expect(official.get("plugin-stars")?.hooks).toEqual(["ranking search tool", "raw GitHub snapshot", "plugin UI"]);
    expect(official.get("plugin-stars")?.profile.config).toEqual({
      sourceUrl: "https://raw.githubusercontent.com/ywsldxk/dsh-plugin-stars/main/data/plugins.json",
      limit: 10,
      timeoutMs: 15_000,
    });
    expect(official.get("vision-toolkit")?.category.id).toBe("multimodal");
    expect(official.get("vision-toolkit")?.description).toMatch(/signature-verified.*PNG.*JPEG.*GIF.*WebP.*bounded header.*cancellable.*local/iu);
    expect(official.get("vision-toolkit")?.capabilities).toEqual([
      "bounded workspace image catalog",
      "signature-verified image metadata",
      "PNG JPEG GIF and WebP dimensions",
      "cancellable bounded traversal",
      "bounded normalized panel",
    ]);
    expect(official.get("vision-toolkit")?.hooks).toEqual(["image metadata tools", "workspace access", "plugin UI"]);
    expect(official.get("vision-toolkit")?.profile.config).toEqual({});
    expect(official.get("session-bridge")?.category.id).toBe("workflow");
    expect(official.get("session-bridge")?.description).toMatch(/preview.*export.*confirmed import.*strictly validated.*bounded.*LLM context.*duplicate/iu);
    expect(official.get("session-bridge")?.capabilities).toEqual([
      "strict bounded handoff format",
      "five-part review preview",
      "confirmed context import",
      "active-session targeting",
      "duplicate import protection",
      "bounded operation status",
      "bounded normalized panel",
    ]);
    expect(official.get("session-bridge")?.hooks).toEqual(["session bridge tools", "active session manager", "custom context messages", "plugin UI"]);
    expect(official.get("session-bridge")?.profile.config).toEqual({});
    expect(official.get("skill-guard")?.category.id).toBe("security");
    expect(official.get("skill-guard")?.description).toMatch(/loaded Skill entry.*bounded heuristic.*does not disable/iu);
    expect(official.get("skill-guard")?.capabilities).toEqual([
      "bounded loaded-entry audit",
      "instruction-override heuristics",
      "secret-exfiltration heuristics",
      "destructive-command and obfuscation heuristics",
      "descriptor-safe cancellable scans",
      "bounded normalized panel",
    ]);
    expect(official.get("skill-guard")?.hooks).toEqual(["skill scan tool", "resource loader", "plugin UI"]);
    expect(official.get("skill-guard")?.profile.config).toEqual({});
    expect(official.get("cost-meter")?.category.id).toBe("observability");
    expect(official.get("cost-meter")?.description).toMatch(/runtime-reported.*UTC daily increments.*bounded local ledger/iu);
    expect(official.get("cost-meter")?.capabilities).toEqual([
      "UTC daily cost ledger",
      "session cost snapshots",
      "daily budget monitoring",
      "bounded local persistence",
    ]);
    expect(official.get("cost-meter")?.hooks).toEqual(["agent end", "cost report tool", "plugin UI"]);
    expect(official.get("cost-meter")?.profile.config).toEqual({ dailyBudget: 0, maxEntries: 365 });
    expect(official.get("skill-catalog")?.category.id).toBe("discovery");
    expect(official.get("prompt-guard")?.category.id).toBe("security");
    expect(official.get("browser-fetch")?.category.id).toBe("web");
    expect(official.get("browser-fetch")?.description).toMatch(/bounded.*text.*descriptor-safe.*DNS.*pinn.*redirect.*private.*timeout.*validated.*panel/iu);
    expect(official.get("browser-fetch")?.capabilities).toEqual([
      "bounded textual HTTP fetch",
      "DNS rebinding protection",
      "per-hop SSRF validation",
      "cancellable request lifecycle",
      "bounded browser preview",
      "validated fail-closed panel reporting",
    ]);
    expect(official.get("browser-fetch")?.profile.config).toEqual({ allowPrivate: false, timeoutMs: 20_000 });
    expect(official.get("web-research")?.category.id).toBe("web");
    expect(official.get("mcp-client")?.category.id).toBe("tools");
    expect(official.get("mcp-client")?.description).toMatch(/MCP stdio.*bounded.*pagination.*tool.*resource.*prompt.*cancellable.*lifecycle/iu);
    expect(official.get("mcp-client")?.capabilities).toEqual([
      "bounded MCP stdio transport",
      "bounded inventory pagination",
      "tool resource and prompt bridging",
      "persistent server lifecycle",
      "cancellable queued requests",
    ]);
    expect(official.get("mcp-client")?.hooks).toEqual(["MCP stdio tools", "managed server lifecycle", "plugin UI"]);
    expect(official.get("mcp-client")?.profile.config).toEqual({ servers: [] });
    expect(official.get("at-file")?.category.id).toBe("context");
    expect(official.get("at-file")?.description).toMatch(/bounded 256 KiB.*UTF-8.*canonical.*untrusted.*closing-tag.*cancellable.*sequential/iu);
    expect(official.get("at-file")?.capabilities).toEqual([
      "256 KiB strict UTF-8 text attachments",
      "canonical workspace path confinement",
      "no-follow regular-file reads",
      "untrusted context framing",
      "closing-tag neutralization",
      "cancellable sequential execution",
      "descriptor-safe normalized panel",
    ]);
    expect(official.get("at-file")?.hooks).toEqual(["file context tool", "workspace file read", "plugin UI"]);
    expect(official.get("at-file")?.profile.config).toEqual({});
    expect(official.get("dependency-checker")?.category.id).toBe("developer");
    expect(official.get("dependency-checker")?.description).toMatch(/bounded.*offline.*read-only.*package\.json.*requirements.*presence.*unresolved/iu);
    expect(official.get("dependency-checker")?.capabilities).toEqual([
      "2000-declaration local presence scan",
      "4096-entry workspace-contained virtualenv scan",
      "npm common-intersection conflict detection",
      "bounded Python numeric constraint analysis",
      "unresolved constraint and directive reporting",
      "optional dependency reporting",
      "descriptor-safe normalized panel",
    ]);
    expect(official.get("dependency-checker")?.hooks).toEqual(["dependency check tool", "workspace manifest read", "plugin UI"]);
    expect(official.get("token-guard")?.category.id).toBe("observability");
    expect(official.get("token-guard")?.description).toMatch(/descriptor-safe.*one abort.*per run.*context.*billed run-token.*cached.*normalized panel/iu);
    expect(official.get("token-guard")?.capabilities).toEqual([
      "strict context percentage budget",
      "optional billed run-token budget",
      "one abort request per run",
      "resilient descriptor-safe monitoring",
      "bounded streaming inspection cadence",
      "bounded abort error status",
      "cached normalized panel",
    ]);
    expect(official.get("token-guard")?.hooks).toEqual(["Pi session lifecycle", "active runtime abort", "session usage and statistics", "plugin UI"]);
    expect(official.get("token-guard")?.profile.config).toEqual({ maxPercent: 90, maxRunTokens: 0 });
    expect(official.get("recall-unread")?.category.id).toBe("workflow");
    expect(official.get("recall-unread")?.description).toMatch(/read-only.*bounded.*strict UTF-8.*current workspace.*unanswered.*cached/iu);
    expect(official.get("recall-unread")?.capabilities).toEqual([
      "bounded current-workspace JSONL discovery",
      "strict UTF-8 no-follow session reads",
      "unanswered-tail detection",
      "cached startup and manual rescans",
      "descriptor-safe cancellable queries",
      "bounded normalized panel",
    ]);
    expect(official.get("recall-unread")?.hooks).toEqual(["recall unread tool", "native session storage", "active session manager", "plugin UI"]);
    expect(official.get("recall-unread")?.profile.config).toEqual({});
    expect(official.get("turn-rewind")?.category.id).toBe("workflow");
    expect(official.get("turn-rewind")?.description).toMatch(/bounded.*current branch.*queued.*cancellable.*native session tree/iu);
    expect(official.get("turn-rewind")?.capabilities).toEqual([
      "bounded current-branch candidate scan",
      "settled-state queued navigation",
      "preserved native session branches",
      "optional branch summarization",
      "cancellable serialized rewinds",
      "bounded normalized operation panel",
    ]);
    expect(official.get("turn-rewind")?.hooks).toEqual(["session rewind tool", "active session tree", "agent settled lifecycle", "plugin UI"]);
    expect(official.get("turn-rewind")?.profile.config).toEqual({});
    expect(official.get("context-doctor")?.category.id).toBe("observability");
    expect(official.get("history-compressor")?.category.id).toBe("context");
    expect(official.get("reviewer-bot")?.category.id).toBe("workflow");
    expect(official.get("auto-mode")?.category.id).toBe("security");
    expect(official.get("plan-execute")?.category.id).toBe("workflow");
    expect(official.get("canvas-draw")?.category.id).toBe("multimodal");
    expect(official.get("canvas-draw")?.description).toMatch(/Mermaid flowchart source/iu);
    expect(official.get("canvas-draw")?.hooks).toEqual(["plugin UI"]);
    expect(official.get("image-compressor")?.category.id).toBe("multimodal");
    expect(official.get("code2skill")?.category.id).toBe("tools");
    expect(official.get("code2skill")?.description).toMatch(/selected workspace source files/iu);
    expect(official.get("code2skill")?.capabilities).toEqual(["bounded skill packaging", "source file preservation", "SKILL.md generation"]);
    expect(official.get("workspace-search")?.category.id).toBe("context");
    expect(official.get("plugin-check")?.category.id).toBe("security");
    expect(official.get("test-harness")?.category.id).toBe("testing");
    expect(official.get("test-harness")?.description).toMatch(
      /five fixed npm script.*trusted workspace.*12 KiB.*UTF-8.*untrusted.*timeout.*cancellable process-tree/iu,
    );
    expect(official.get("test-harness")?.capabilities).toEqual([
      "five-script verification allowlist",
      "real npm exit status and signal reporting",
      "12 KiB UTF-8-safe output tail",
      "terminal-control sanitization and untrusted framing",
      "configurable bounded timeout",
      "cancellable process-tree cleanup",
      "descriptor-safe normalized panel",
    ]);
    expect(official.get("test-harness")?.hooks).toEqual(["project verification tool", "workspace npm scripts", "plugin UI"]);
    expect(official.get("test-harness")?.profile.config).toEqual({ timeoutMs: 120_000 });
    expect(official.get("git-time-capsule")?.category.id).toBe("workflow");
    expect(official.get("git-time-capsule")?.description).toMatch(/unstaged tracked Git diff.*byte.*validated.*reverse/iu);
    expect(official.get("git-time-capsule")?.capabilities).toEqual([
      "byte-exact validated unstaged diff capture",
      "exclusive no-clobber capsule publication",
      "confirmed deterministic reverse apply",
      "bounded 256-capsule inventory",
      "cancellable serialized Git operations",
      "descriptor-safe normalized panel",
    ]);
    expect(official.get("git-time-capsule")?.hooks).toEqual(["Git snapshot tool", "Git restore tool", "plugin UI"]);
    expect(official.get("git-time-capsule")?.profile.config).toEqual({ timeoutMs: 15_000 });
    expect(official.get("graph-memory")?.description).toMatch(/bounded typed.*directed relations.*atomic.*cross-session/iu);
    expect(official.get("graph-memory")?.capabilities).toEqual([
      "bounded typed nodes",
      "validated directed relations",
      "ranked graph search",
      "atomic locked persistence",
    ]);
    expect(official.get("graph-memory")?.hooks).toEqual(["graph memory tools", "local graph file", "plugin UI"]);
    expect(official.get("graph-memory")?.profile.config).toEqual({ fileName: "graph-memory.json", maxNodes: 2_000, maxRelations: 5_000 });
    expect(official.get("yaml-validator")?.category.id).toBe("developer");
    expect(official.get("yaml-validator")?.description).toMatch(/workspace-contained.*UTF-8.*multi-document.*bounded.*cancellable/iu);
    expect(official.get("yaml-validator")?.capabilities).toEqual([
      "workspace-contained bounded reads",
      "strict UTF-8 multi-document YAML",
      "line-aware error and warning diagnostics",
      "cancellable validation lifecycle",
      "bounded panel previews",
    ]);
    expect(official.get("yaml-validator")?.hooks).toEqual(["YAML validation tool", "workspace files", "plugin UI"]);
    expect(official.get("yaml-validator")?.profile.config).toEqual({});
    expect(official.get("browser-session")?.category.id).toBe("web");
    expect(official.get("browser-session")?.category).toEqual(official.get("browser-fetch")?.category);
    expect(official.get("browser-session")?.description).toMatch(/loopback-only.*descriptor-safe.*bounded.*cancellable.*screenshot.*validated.*panel/iu);
    expect(official.get("browser-session")?.capabilities).toEqual([
      "loopback-only CDP endpoint",
      "bounded tab discovery",
      "navigation read click and screenshot tools",
      "cancellable request lifecycle",
      "bounded panel previews",
      "validated fail-closed panel reporting",
    ]);
    expect(official.get("browser-session")?.hooks).toEqual(["browser session tools", "Chrome DevTools Protocol", "plugin UI"]);
    expect(official.get("browser-session")?.profile.config).toEqual({ endpoint: "http://127.0.0.1:9222" });
    expect(official.get("docker-sandbox")?.category.id).toBe("security");
    expect(official.get("docker-sandbox")?.description).toMatch(
      /descriptor-safe.*local-only.*no container network.*read-only workspace.*CPU.*memory.*PID.*sanitized output.*strict panel.*cancellation cleanup/iu,
    );
    expect(official.get("docker-sandbox")?.capabilities).toEqual([
      "local-only image execution",
      "no-network containers",
      "read-only workspace by default",
      "CPU memory and PID limits",
      "sanitized bounded output",
      "strict panel reporting",
      "cancellation cleanup",
    ]);
    expect(official.get("docker-sandbox")?.hooks).toEqual(["sandbox execution tool", "Docker CLI", "plugin UI"]);
    expect(official.get("docker-sandbox")?.profile.config).toEqual({});
    expect(official.get("mock-server")?.category.id).toBe("tools");
    expect(official.get("sql-lens")?.category.id).toBe("tools");
    expect(official.get("sql-lens")?.description).toMatch(
      /workspace.*SQLite.*strict.*descriptor-safe.*single.*read-only.*bounded.*symlink.*timed.*cancellation.*fail-closed.*panel/iu,
    );
    expect(official.get("sql-lens")?.capabilities).toEqual([
      "single-statement SQLite inspection",
      "isolated read-only query worker",
      "bounded rows cells and result bytes",
      "workspace and symlink safety checks",
      "timeout and cancellation termination",
      "validated fail-closed panel reporting",
    ]);
    expect(official.get("sql-lens")?.hooks).toEqual(["SQL read-only tool", "workspace SQLite files", "plugin UI"]);
    expect(official.get("sql-lens")?.profile.config).toEqual({ timeoutMs: 5_000 });
    expect(official.get("i18n-pair")?.category.id).toBe("workflow");
    expect(official.get("i18n-pair")?.description).toMatch(
      /strict read-only.*bounded JSON locale.*no-follow workspace.*collision-safe missing.*extra.*stable failures.*cancellation.*validated panel/iu,
    );
    expect(official.get("i18n-pair")?.capabilities).toEqual([
      "collision-safe locale key parity",
      "strict bounded workspace-only JSON reads",
      "no-follow symbolic-link safety",
      "stable sequential cancellable inspection",
      "validated bounded panel reporting",
    ]);
    expect(official.get("i18n-pair")?.hooks).toEqual(["i18n check tool", "workspace locale files", "plugin UI"]);
    expect(official.get("i18n-pair")?.profile.config).toEqual({});
    expect(official.get("plugin-finder")?.category.id).toBe("discovery");
    expect(official.get("readme-gen")?.category.id).toBe("developer");
    expect(official.get("readme-gen")?.description).toMatch(
      /strictly bounded manifest.*descriptor-safe loader.*Markdown-safe.*confirmed.*no-clobber atomic.*explicit overwrite.*cancellable/iu,
    );
    expect(official.get("readme-gen")?.capabilities).toEqual([
      "bounded manifest metadata",
      "descriptor-safe loader inventory",
      "Markdown-safe rendering",
      "confirmed no-clobber atomic writes",
      "explicit overwrite confirmation",
      "cancellable sequential tools",
      "bounded normalized operation panel",
    ]);
    expect(official.get("readme-gen")?.hooks).toEqual([
      "README report and write tools",
      "workspace manifest and files",
      "Cordis loader inventory",
      "plugin UI",
    ]);
    expect(official.get("readme-gen")?.profile.config).toEqual({});
    expect(official.get("anchored-standard")?.category.id).toBe("security");
    expect(official.get("annotation")?.hooks).toEqual(["plugin UI"]);
    expect(official.get("change-verifier")?.category.id).toBe("workflow");
    expect(official.get("openpets")?.category.id).toBe("web");
    expect(official.get("openpets")?.description).toMatch(
      /bounded.*companion state.*validated.*session entr.*without retaining message contents.*persistence/iu,
    );
    expect(official.get("openpets")?.capabilities).toEqual([
      "bounded durable companion state",
      "validated session recovery",
      "descriptor-safe pet actions",
      "session event reactions",
      "persistence health panel",
    ]);
    expect(official.get("openpets")?.hooks).toEqual(["session events", "pet reaction tool", "session storage", "plugin UI"]);
    expect(official.get("openpets")?.profile.config).toEqual({});
    expect(official.get("session-insights")?.category.id).toBe("observability");
    expect(official.get("session-insights")?.description).toMatch(
      /descriptor-safe.*validated.*cached.*session.*statistics.*confirmed.*settled.*compaction.*model.*usage.*cost.*cancellable/iu,
    );
    expect(official.get("session-insights")?.capabilities).toEqual([
      "validated detached session statistics",
      "message token cache cost and context accounting",
      "cached active-session panel",
      "confirmed settled-session compaction",
      "dedicated compaction cancellation",
      "single-flight bounded operation status",
      "normalized fail-closed browser view",
    ]);
    expect(official.get("session-insights")?.hooks).toEqual(["session report tool", "active runtime session", "Pi session lifecycle", "plugin UI"]);
    expect(official.get("session-insights")?.profile.config).toEqual({});
    expect(official.get("mcp-panel")?.category.id).toBe("tools");
    expect(official.get("fail-logger")?.category.id).toBe("observability");
    expect(official.get("fail-logger")?.description).toMatch(
      /bounded.*extension.*Agent.*non-aborted compaction.*descriptor-safe event inspection.*safe diagnostic.*occurrence counts/iu,
    );
    expect(official.get("fail-logger")?.capabilities).toEqual([
      "bounded failure aggregation",
      "descriptor-safe event inspection",
      "abort-aware compaction diagnostics",
      "occurrence counting",
      "safe diagnostic summaries",
      "capacity visibility",
    ]);
    expect(official.get("fail-logger")?.hooks).toEqual(["extension error", "agent end", "compaction end", "plugin UI"]);
    expect(official.get("genui")?.description).toMatch(/bounded.*text, badge, and decimal progress.*plain text/iu);
    expect(official.get("genui")?.capabilities).toEqual([
      "bounded structured cards",
      "typed text badge and progress blocks",
      "decimal progress validation",
      "plain-text HTML handling",
    ]);
    expect(official.get("genui")?.hooks).toEqual(["GenUI render tool", "plugin UI"]);
    expect(official.get("plugin-dev")?.category.id).toBe("developer");
    expect(official.get("plugin-dev")?.description).toMatch(/defer.*session resource.*agent.*settled.*single.*reload.*bounded.*trusted.*development/iu);
    expect(official.get("plugin-dev")?.capabilities).toEqual([
      "settled-session resource reload",
      "single-flight reload guard",
      "bounded reload status",
      "cancellable caller wait",
    ]);
    expect(official.get("plugin-dev")?.hooks).toEqual(["session resource reload tool", "Pi session lifecycle", "plugin UI"]);
    expect(official.get("plugin-dev")?.profile.config).toEqual({});
    expect(official.get("session-export")?.category.id).toBe("workflow");
    expect(official.get("session-search")?.category.id).toBe("discovery");
    expect(official.get("session-compare")?.category.id).toBe("discovery");
    expect(official.get("secure-audit")?.category.id).toBe("security");
    expect(official.get("session-bookmarks")?.category.id).toBe("workflow");
    expect(official.get("llm-verifier")?.category.id).toBe("testing");
    expect(official.get("module-search")?.category.id).toBe("discovery");
    expect(official.get("workspace-navigator")?.category.id).toBe("developer");
    expect(official.get("reverse-skill")?.category.id).toBe("security");
    expect(official.get("colleague-skill")?.category.id).toBe("workflow");
    expect(official.get("colleague-skill")?.hooks).toEqual(["session storage", "plugin UI"]);
    expect(official.get("context-insights")?.category.id).toBe("context");
    expect(official.get("context-insights")?.description).toMatch(
      /descriptor-safe.*bounded message composition.*cached.*active-session.*lifecycle.*normalized browser/iu,
    );
    expect(official.get("context-insights")?.capabilities).toEqual([
      "descriptor-safe bounded message composition",
      "resilient context usage inspection",
      "active-session lifecycle counters",
      "cached session-aware panel",
      "bounded normalized browser view",
    ]);
    expect(official.get("context-insights")?.hooks).toEqual(["context inspection tool", "active runtime session", "Pi session lifecycle", "plugin UI"]);
    expect(official.get("context-insights")?.profile.config).toEqual({});
    expect(official.get("context-doctor")?.category.id).toBe("observability");
    expect(official.get("context-doctor")?.description).toMatch(/descriptor-safe.*bounded.*queued.*agent.*settled.*confirmed.*model.*cost.*cancellable/iu);
    expect(official.get("context-doctor")?.capabilities).toEqual([
      "descriptor-safe bounded context audit",
      "pressure oversized uninspectable and tool-error diagnostics",
      "confirmed settled-session compaction",
      "dedicated compaction cancellation",
      "single-flight bounded operation status",
      "cached normalized panel",
    ]);
    expect(official.get("context-doctor")?.hooks).toEqual([
      "context doctor tool",
      "session messages and usage",
      "Pi session lifecycle",
      "manual compaction",
      "plugin UI",
    ]);
    expect(official.get("context-doctor")?.profile.config).toEqual({});
    expect(official.get("cordis-group")?.category.id).toBe("composition");
    expect(official.get("cordis-group")?.capabilities).toEqual(["nested plugin composition", "transactional rollback", "lifecycle ownership"]);
    expect(official.get("cordis-group")?.hooks).toEqual(["loader entry tree"]);
    expect(official.get("cordis-logger-console")?.category.id).toBe("observability");
    expect(official.get("cordis-logger-console")?.capabilities).toEqual(["bounded console logging", "per-logger severity filtering", "safe recent-log panel"]);
    expect(official.get("cordis-logger-console")?.hooks).toEqual(["Cordis logger exporter", "plugin UI"]);
    expect(official.get("cordis-logger-console")?.profile.config).toEqual({ levels: { default: 2 }, maxLength: 8_192 });
    expect(official.get("cordis-timer")?.category.id).toBe("runtime");
    expect(official.get("cordis-timer")?.capabilities).toEqual([
      "scheduling",
      "lifecycle-owned cancellation",
      "async interval iteration",
      "throttle and debounce",
    ]);
    expect(official.get("cordis-timer")?.hooks).toEqual(["Cordis timer service", "plugin UI"]);
    expect(official.get("prompt-library")?.category.id).toBe("workflow");
    expect(official.get("cleaner")?.category.id).toBe("developer");
    expect(official.get("cleaner")?.description).toMatch(
      /strict.*descriptor-safe.*display-safe.*bounded.*Git capsule.*explicit confirmation.*retention.*symlink.*replacement.*cancellable.*fail-closed/iu,
    );
    expect(official.get("cleaner")?.capabilities).toEqual([
      "strict configuration and parameters",
      "bounded capsule inventory",
      "display-safe capsule filtering",
      "confirmed retention cleanup",
      "symlink and replacement defenses",
      "cancellable serialized cleanup",
      "fail-closed normalized panel",
    ]);
    expect(official.get("cleaner")?.hooks).toEqual(["capsule cleanup tool", "agent capsule directory", "plugin UI"]);
    expect(official.get("cleaner")?.profile.config).toEqual({});
    expect(official.get("cli-notifier")?.category.id).toBe("workflow");
    expect(official.get("cli-notifier")?.description).toMatch(/local desktop notifications/iu);
    expect(official.get("cli-notifier")?.description).not.toMatch(/webhook/iu);
    expect(official.get("cli-notifier")?.capabilities).toEqual(["desktop notification", "completion notice", "failure and abort notice"]);
    expect(official.get("cli-notifier")?.hooks).toEqual(["agent end", "compaction error", "plugin UI"]);
    expect(official.get("obsidian-sync")?.category.id).toBe("workflow");
    expect(official.get("tab-manager")?.category.id).toBe("workflow");
    expect(official.get("telemetry-blocker")?.category.id).toBe("security");
    expect(official.get("runtime-doctor")?.category.id).toBe("developer");
    expect(official.get("better-sidebar")?.category.id).toBe("developer");
  });

  test("lists every plugin as an installable npm package rather than a launcher subpath", () => {
    const subpaths = MARKETPLACE_PLUGINS.filter((plugin) => plugin.packageName.includes("/plugins/"));
    expect(subpaths).toEqual([]);
    expect(MARKETPLACE_PLUGINS.every((plugin) => marketplaceNpmPackageName(plugin.packageName) === plugin.packageName)).toBe(true);
    expect(MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "skill-guard")?.packageName).toBe("@pi-harness/plugin-skill-guard");
  });

  test("filters by query and capability without mutating the registry", () => {
    const result = searchMarketplace("timer", "scheduling");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(searchMarketplace("does-not-exist")).toEqual([]);
    expect(MARKETPLACE_PLUGINS.length).toBeGreaterThan(3);
  });

  test("filters by a declared category independently from capabilities", () => {
    const result = searchMarketplace("", "", "runtime");
    expect(result.map((plugin) => plugin.packageName)).toEqual(["@deepseek-ai/cordis-plugin-timer"]);
    expect(result[0]?.category).toEqual({ id: "runtime", label: "运行时" });
    expect(MARKETPLACE_CATEGORIES).toEqual(expect.arrayContaining([{ id: "runtime", label: "运行时", count: 1 }]));
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
    expect(MARKETPLACE_CAPABILITIES).toContain("scheduling");
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
