import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type SessionStats } from "@earendil-works/pi-coding-agent";

const defaultFileName = "cost-meter.json";
const defaultMaxEntries = 365;
const maxFileEntries = 2_000;

export interface CostMeterPluginConfig {
  fileName?: string;
  dailyBudget?: number;
  maxEntries?: number;
}

export const Config: z<CostMeterPluginConfig> = z.object({
  fileName: z.string().default(defaultFileName),
  dailyBudget: z.number().default(0),
  maxEntries: z.number().default(defaultMaxEntries),
});

export interface CostEntry {
  sessionId: string;
  cost: number;
  tokens: number;
  messages: number;
  recordedAt: string;
}

export interface CostMeterReport {
  sessionCost: number;
  todayCost: number;
  lifetimeCost: number;
  budget: number | null;
  budgetPercent: number | null;
  entries: CostEntry[];
}

interface CostFile {
  version: 1;
  entries: CostEntry[];
}

function normalizeFilePath(agentDir: string, fileName: string | undefined): string {
  const name = (fileName ?? defaultFileName).trim();
  if (name === "" || basename(name) !== name || !name.toLowerCase().endsWith(".json")) throw new Error("Cost meter fileName must be a single .json filename");
  return resolve(agentDir, name);
}

function finiteCost(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}

function todayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function reportFor(entries: readonly CostEntry[], current: SessionStats, budget: number | null): CostMeterReport {
  const today = todayKey(new Date());
  const todayCost = entries.filter((entry) => entry.recordedAt.slice(0, 10) === today).reduce((sum, entry) => sum + entry.cost, 0);
  const lifetimeCost = entries.reduce((sum, entry) => sum + entry.cost, 0);
  const roundedToday = finiteCost(todayCost);
  return {
    sessionCost: finiteCost(current.cost),
    todayCost: roundedToday,
    lifetimeCost: finiteCost(lifetimeCost),
    budget,
    budgetPercent: budget === null || budget === 0 ? null : Math.round((roundedToday / budget) * 10_000) / 100,
    entries: [...entries],
  };
}

export default {
  name: "pi-cost-meter",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: CostMeterPluginConfig) {
    const filePath = normalizeFilePath(context.piHarnessLaunch.agentDir, config.fileName);
    const budgetValue =
      typeof config.dailyBudget === "number" && Number.isFinite(config.dailyBudget) && config.dailyBudget > 0 ? finiteCost(config.dailyBudget) : null;
    const entryLimit = Math.max(1, Math.min(maxFileEntries, Math.trunc(config.maxEntries ?? defaultMaxEntries)));
    let entries: CostEntry[] = [];
    let loaded = false;
    let loading: Promise<void> | undefined;
    let writeQueue = Promise.resolve();
    let pendingRecord: Promise<void> | undefined;
    const runtime = () => {
      const service = context.get("piRuntime");
      if (service === undefined) throw new Error("Pi runtime is not ready");
      return service;
    };
    const load = async (): Promise<void> => {
      if (loaded) return;
      if (loading !== undefined) return loading;
      loading = (async () => {
        try {
          const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<CostFile>;
          if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("Cost meter file has an unsupported format");
          entries = parsed.entries.filter(
            (entry): entry is CostEntry =>
              typeof entry === "object" &&
              entry !== null &&
              typeof entry.sessionId === "string" &&
              typeof entry.recordedAt === "string" &&
              typeof entry.cost === "number",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          entries = [];
        }
        loaded = true;
      })();
      return loading;
    };
    const persist = async (): Promise<void> => {
      const payload = JSON.stringify({ version: 1, entries } satisfies CostFile, null, 2);
      writeQueue = writeQueue.then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const temporary = join(dirname(filePath), `.${basename(filePath)}.tmp`);
        await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, filePath);
      });
      await writeQueue;
    };
    const record = async (): Promise<void> => {
      await load();
      const current = runtime().session.getSessionStats();
      const signature = `${current.sessionId}:${current.totalMessages}:${finiteCost(current.cost)}`;
      if (entries.some((entry) => `${entry.sessionId}:${entry.messages}:${entry.cost}` === signature)) return;
      entries = [
        {
          sessionId: current.sessionId,
          cost: finiteCost(current.cost),
          tokens: current.tokens.total,
          messages: current.totalMessages,
          recordedAt: new Date().toISOString(),
        },
        ...entries,
      ].slice(0, entryLimit);
      await persist();
    };
    const readReport = async (): Promise<CostMeterReport> => {
      await load();
      await pendingRecord;
      return reportFor(entries, runtime().session.getSessionStats(), budgetValue);
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      if (event.type === "agent_end") pendingRecord = record();
    });
    const unregister = context.piTools.register(
      defineTool({
        name: "cost_report",
        label: "Cost report",
        description: "Inspect current-session, daily, and persisted local model cost usage with an optional daily budget.",
        promptSnippet: "inspect session and daily model cost usage",
        parameters: Type.Object({ refresh: Type.Optional(Type.Boolean({ description: "Record the current completed session before reporting" })) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<CostMeterReport>> {
          if (params.refresh === true) await record();
          const report = await readReport();
          return {
            content: [{ type: "text", text: `Today cost $${report.todayCost.toFixed(4)}; current session $${report.sessionCost.toFixed(4)}.` }],
            details: report,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "cost-meter-panel",
      pluginId: "@pi-harness/core/plugins/cost-meter",
      title: "Cost Meter",
      description: "查看当前会话、今日和历史成本，并监控每日预算。",
      icon: "¤",
      read: readReport,
    });
    context.effect(() => () => {
      unsubscribe();
      unregister();
      disposePanel();
    });
  },
};
