import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const maxMessageLength = 2048;
const maxNotifications = 20;
type Notification = { time: string; title: string; message: string; delivered: boolean; reason?: string };
type NotificationResult = { title: string; message: string; delivered: boolean; platform: NodeJS.Platform; reason?: string };

export interface CliNotifierPluginConfig {
  enabled?: boolean;
  title?: string;
}

export const Config: z<CliNotifierPluginConfig> = z.object({ enabled: z.boolean().default(true), title: z.string().default("Pi Harness") });

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ")}"`;
}

async function deliver(title: string, message: string): Promise<NotificationResult> {
  const platform = process.platform;
  if (platform === "darwin") {
    await execFileAsync("osascript", ["-e", `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`]);
    return { title, message, delivered: true, platform };
  }
  if (platform === "linux") {
    await execFileAsync("notify-send", [title, message]);
    return { title, message, delivered: true, platform };
  }
  if (platform === "win32") {
    const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</text><text id="2">${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</text></binding></visual></toast>'); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi Harness').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return { title, message, delivered: true, platform };
  }
  return { title, message, delivered: false, platform, reason: "unsupported-platform" };
}

export default {
  name: "pi-cli-notifier",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: CliNotifierPluginConfig) {
    const enabled = config.enabled !== false;
    const defaultTitle = config.title?.trim() || "Pi Harness";
    const notifications: Notification[] = [];
    const notify = async (message: string, title = defaultTitle): Promise<NotificationResult> => {
      if (message.length === 0 || message.length > maxMessageLength)
        throw new Error(`Notification message must be between 1 and ${maxMessageLength} characters`);
      if (title.length === 0 || title.length > 256) throw new Error("Notification title must be between 1 and 256 characters");
      if (!enabled) {
        const result: NotificationResult = { title, message, delivered: false, platform: process.platform, reason: "disabled" };
        notifications.unshift({ time: new Date().toISOString(), ...result });
        notifications.splice(maxNotifications);
        return result;
      }
      try {
        const result = await deliver(title, message);
        notifications.unshift({ time: new Date().toISOString(), ...result });
        notifications.splice(maxNotifications);
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const result: NotificationResult = { title, message, delivered: false, platform: process.platform, reason };
        notifications.unshift({ time: new Date().toISOString(), ...result });
        notifications.splice(maxNotifications);
        return result;
      }
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "cli_notify",
        label: "CLI notify",
        description: "Send a local desktop notification without invoking a shell.",
        promptSnippet: "send a desktop notification when this task finishes",
        parameters: Type.Object({
          message: Type.String({ description: "Notification body" }),
          title: Type.Optional(Type.String({ description: "Notification title" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<NotificationResult>> {
          const result = await notify(params.message, params.title ?? defaultTitle);
          return {
            content: [
              { type: "text", text: result.delivered ? "Desktop notification sent." : `Desktop notification not sent: ${result.reason ?? "unknown reason"}` },
            ],
            details: result,
          };
        },
      }),
    );
    const unsubscribeSession = context.on("pi/session-event", (event) => {
      const current = event as {
        type?: string;
        messages?: readonly { role?: string; stopReason?: string; errorMessage?: string }[];
        errorMessage?: string;
      };
      if (current.type === "agent_end") {
        const last = current.messages?.at(-1);
        if (last?.role === "assistant") {
          const message = last.stopReason === "error" ? `Agent failed: ${last.errorMessage ?? "unknown error"}` : "Agent turn completed.";
          void notify(message);
        }
      } else if (current.type === "compaction_end" && current.errorMessage) {
        void notify(`Context compaction failed: ${current.errorMessage}`);
      }
    });
    const disposePanel = context.piPluginUi.register({
      id: "cli-notifier-panel",
      pluginId: "@pi-harness/core/plugins/cli-notifier",
      title: "CLI Notifier",
      description: "长任务完成后发送本机桌面通知。",
      icon: "♢",
      read: () => ({ enabled, platform: process.platform, notifications: [...notifications] }),
    });
    context.effect(() => () => {
      unregisterTool();
      unsubscribeSession();
      disposePanel();
    });
  },
};
