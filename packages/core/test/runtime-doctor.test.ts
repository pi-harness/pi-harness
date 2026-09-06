import { describe, expect, test } from "vitest";
import { diagnoseRuntime } from "../src/plugins/runtime-doctor.js";

describe("runtime doctor", () => {
  test("reports actionable failures and warnings", () => {
    const report = diagnoseRuntime({
      cwd: "/workspace",
      agentDir: "/agent",
      cwdExists: true,
      agentDirExists: false,
      model: { provider: "everyapi", id: "deepseek-v4-flash" },
      runtimeReady: true,
      mcpServers: 2,
      extensionErrors: 1,
    });
    expect(report.status).toBe("error");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        { id: "workspace", status: "ok", detail: "/workspace" },
        { id: "agent-dir", status: "error", detail: "/agent 不存在" },
        { id: "model", status: "ok", detail: "everyapi/deepseek-v4-flash" },
        { id: "runtime", status: "ok", detail: "运行时已就绪" },
        { id: "mcp", status: "ok", detail: "2 个 MCP 服务" },
        { id: "extensions", status: "warning", detail: "1 个扩展错误" },
      ]),
    );
    expect(report.recommendations).toContain("检查 agent 目录路径和权限。");
    expect(report.recommendations).toContain("查看扩展错误并禁用失败的扩展。");
  });

  test("stays healthy when all runtime boundaries are ready", () => {
    const report = diagnoseRuntime({
      cwd: "/workspace",
      agentDir: "/agent",
      cwdExists: true,
      agentDirExists: true,
      model: { provider: "everyapi", id: "deepseek-v4-flash" },
      runtimeReady: true,
      mcpServers: 0,
      extensionErrors: 0,
    });
    expect(report).toEqual({
      status: "ok",
      checks: [
        { id: "workspace", status: "ok", detail: "/workspace" },
        { id: "agent-dir", status: "ok", detail: "/agent" },
        { id: "model", status: "ok", detail: "everyapi/deepseek-v4-flash" },
        { id: "runtime", status: "ok", detail: "运行时已就绪" },
        { id: "mcp", status: "ok", detail: "没有运行中的 MCP 服务" },
        { id: "extensions", status: "ok", detail: "没有扩展错误" },
      ],
      recommendations: [],
    });
  });
});
