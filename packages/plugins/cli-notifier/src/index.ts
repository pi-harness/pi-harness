import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

const execFileAsync = promisify(execFile);
const maxMessageLength = 2048;
const maxTitleLength = 256;
const maxReasonLength = 1024;
const maxNotifications = 20;
const defaultTimeoutMs = 10_000;
const maxCommandOutputBytes = 256 * 1024;
const windowsNotificationScript =
  "$message = [System.Security.SecurityElement]::Escape([string]$env:PI_HARNESS_NOTIFICATION_MESSAGE); $title = [System.Security.SecurityElement]::Escape([string]$env:PI_HARNESS_NOTIFICATION_TITLE); [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml(\"<toast><visual><binding template='ToastText02'><text id='1'>$message</text><text id='2'>$title</text></binding></visual></toast>\"); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi Harness').Show([Windows.UI.Notifications.ToastNotification]::new($xml))";
type Notification = { time: string; title: string; message: string; delivered: boolean; reason?: string };
type NotificationResult = { title: string; message: string; delivered: boolean; platform: NodeJS.Platform; reason?: string };

export interface CliNotifierPluginConfig {
  enabled?: boolean;
  title?: string;
  timeoutMs?: number;
}

export const Config: z<CliNotifierPluginConfig> = z.object({
  enabled: z.boolean().default(true),
  title: z.string().max(maxTitleLength).default("Pi Harness"),
  timeoutMs: z.number().min(100).max(60_000).step(1).default(defaultTimeoutMs),
});

function appleScriptString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\r\n\u2028\u2029]/gu, " ")}"`;
}

function boundedEventMessage(value: string): string {
  return value.length <= maxMessageLength ? value : `${value.slice(0, maxMessageLength - 1)}…`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Desktop notification was cancelled", { cause: signal.reason });
}

function normalizeText(value: unknown, label: "message" | "title", maximum: number): string {
  if (typeof value !== "string") throw new Error(`Notification ${label} must be a string`);
  if (value.length === 0 || value.length > maximum || value.trim().length === 0 || value.includes("\0"))
    throw new Error(`Notification ${label} must be non-blank text between 1 and ${maximum} characters without null bytes`);
  return value;
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultTimeoutMs;
  return Math.max(100, Math.min(60_000, Math.trunc(value)));
}

function boundedReason(value: unknown): string {
  const reason = value instanceof Error ? value.message : String(value);
  return reason.length <= maxReasonLength ? reason : `${reason.slice(0, maxReasonLength - 1)}…`;
}

async function deliver(title: string, message: string, timeoutMs: number, signal: AbortSignal): Promise<NotificationResult> {
  const platform = process.platform;
  const options = { timeout: timeoutMs, maxBuffer: maxCommandOutputBytes, signal };
  if (platform === "darwin") {
    await execFileAsync("osascript", ["-e", `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`], options);
    return { title, message, delivered: true, platform };
  }
  if (platform === "linux") {
    await execFileAsync("notify-send", ["--", title, message], options);
    return { title, message, delivered: true, platform };
  }
  if (platform === "win32") {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsNotificationScript], {
      ...options,
      env: { ...process.env, PI_HARNESS_NOTIFICATION_MESSAGE: message, PI_HARNESS_NOTIFICATION_TITLE: title },
    });
    return { title, message, delivered: true, platform };
  }
  return { title, message, delivered: false, platform, reason: "unsupported-platform" };
}

export default {
  name: "pi-cli-notifier",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: CliNotifierPluginConfig = {}) {
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("CLI Notifier enabled must be a boolean");
    const enabled = config.enabled !== false;
    const configuredTitle = config.title === undefined || config.title.trim() === "" ? "Pi Harness" : config.title.trim();
    const defaultTitle = normalizeText(configuredTitle, "title", maxTitleLength);
    const timeoutMs = normalizeTimeout(config.timeoutMs);
    const lifecycle = new AbortController();
    let deliveryQueue: Promise<void> = Promise.resolve();
    const notifications: Notification[] = [];
    const record = (result: NotificationResult): NotificationResult => {
      notifications.unshift({ time: new Date().toISOString(), ...result });
      notifications.splice(maxNotifications);
      return result;
    };
    const notify = async (messageValue: unknown, titleValue: unknown = defaultTitle, signal = lifecycle.signal): Promise<NotificationResult> => {
      const message = normalizeText(messageValue, "message", maxMessageLength);
      const title = normalizeText(titleValue, "title", maxTitleLength);
      throwIfAborted(signal);
      if (!enabled) {
        return record({ title, message, delivered: false, platform: process.platform, reason: "disabled" });
      }
      const operation = deliveryQueue.then(async () => {
        throwIfAborted(signal);
        try {
          return record(await deliver(title, message, timeoutMs, signal));
        } catch (error) {
          throwIfAborted(signal);
          const timedOut = typeof error === "object" && error !== null && "killed" in error && (error as { killed?: unknown }).killed === true;
          const reason = timedOut ? `Notification command timed out after ${timeoutMs} ms` : boundedReason(error);
          return record({ title, message, delivered: false, platform: process.platform, reason });
        }
      });
      deliveryQueue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "cli_notify",
        label: "CLI notify",
        description: "Send a local desktop notification without invoking a shell.",
        promptSnippet: "send a desktop notification when this task finishes",
        parameters: Type.Object(
          {
            message: Type.String({ description: "Notification body", minLength: 1, maxLength: maxMessageLength }),
            title: Type.Optional(Type.String({ description: "Notification title", minLength: 1, maxLength: maxTitleLength })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<NotificationResult>> {
          const record = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
          const actionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const result = await notify(record.message, record.title ?? defaultTitle, actionSignal);
          return {
            content: [
              { type: "text", text: result.delivered ? "Desktop notification sent." : `Desktop notification not sent: ${result.reason ?? "unknown reason"}` },
            ],
            details: structuredClone(result),
          };
        },
      }),
    );
    const unsubscribeSession = context.on("pi/session-event", (event) => {
      const current = event as {
        type?: string;
        messages?: readonly { role?: string; stopReason?: string; errorMessage?: string }[];
        errorMessage?: string;
        willRetry?: boolean;
      };
      if (current.type === "agent_end" && current.willRetry !== true) {
        const last = current.messages?.at(-1);
        if (last?.role === "assistant") {
          const message =
            last.stopReason === "error"
              ? `Agent failed: ${last.errorMessage ?? "unknown error"}`
              : last.stopReason === "aborted"
                ? "Agent turn aborted."
                : last.stopReason === "length"
                  ? "Agent turn stopped at the model output limit."
                  : "Agent turn completed.";
          void notify(boundedEventMessage(message), defaultTitle, lifecycle.signal).catch(() => undefined);
        }
      } else if (current.type === "compaction_end" && current.errorMessage) {
        void notify(boundedEventMessage(`Context compaction failed: ${current.errorMessage}`), defaultTitle, lifecycle.signal).catch(() => undefined);
      }
    });
    const disposePanel = context.piPluginUi.register({
      id: "cli-notifier-panel",
      pluginId: "@pi-harness/plugin-cli-notifier",
      title: "CLI Notifier",
      description: "长任务完成后发送本机桌面通知。",
      icon: "♢",
      read: () => ({ enabled, platform: process.platform, timeoutMs, notifications: structuredClone(notifications) }),
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("CLI Notifier plugin disposed"));
      unregisterTool();
      unsubscribeSession();
      disposePanel();
    });
  },
};
