// Inert local MCP fixture: stdio only, no filesystem writes or network calls.
import { createInterface } from "node:readline";
import process from "node:process";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const schema = {
  type: "object",
  properties: { auditValue: { type: "string", description: "Synthetic value to echo" } },
  required: ["auditValue"],
  additionalProperties: false,
};
const tools = [
  { name: "audit_echo", description: "Echo a synthetic value and report fixture identity", inputSchema: schema },
  { name: "audit_structured", description: "Return structured synthetic data", inputSchema: { type: "object" } },
  { name: "audit_error", description: "Return a deliberate tool execution error", inputSchema: { type: "object" } },
];
const resources = [1, 2].map((n) => ({ uri: `audit://resource/${n}`, name: `Audit Resource ${n}`, mimeType: "text/plain" }));
const prompts = [
  { name: "audit_prompt", description: "Render a synthetic prompt", arguments: [{ name: "subject", description: "Synthetic subject", required: true }] },
];
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  /** @type {unknown} */
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(request) || (typeof request.id !== "string" && typeof request.id !== "number")) return;
  const params = isRecord(request.params) ? request.params : {};
  const args = isRecord(params.arguments) ? params.arguments : {};
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "pih-production-audit", version: "1" },
      };
      break;
    case "tools/list":
      result = params.cursor === "tools-next" ? { tools: tools.slice(1) } : { tools: tools.slice(0, 1), nextCursor: "tools-next" };
      break;
    case "tools/call":
      if (params.name === "audit_echo")
        result =
          typeof args.auditValue === "string"
            ? { content: [{ type: "text", text: JSON.stringify({ value: args.auditValue, pid: process.pid, cwd: process.cwd() }) }] }
            : { isError: true, content: [{ type: "text", text: "auditValue is required" }] };
      else if (params.name === "audit_structured") result = { content: [], structuredContent: { evidence: "PIH_STRUCTURED_FIXTURE", count: 7 } };
      else result = { isError: true, content: [{ type: "text", text: "Deliberate synthetic tool failure" }] };
      break;
    case "resources/list":
      result = params.cursor === "resources-next" ? { resources: resources.slice(1) } : { resources: resources.slice(0, 1), nextCursor: "resources-next" };
      break;
    case "resources/read":
      result = { contents: [{ uri: params.uri, mimeType: "text/plain", text: "PIH_RESOURCE_FIXTURE" }] };
      break;
    case "prompts/list":
      result = { prompts };
      break;
    case "prompts/get":
      result = {
        description: "Synthetic prompt",
        messages: [{ role: "user", content: { type: "text", text: `Review ${typeof args.subject === "string" ? args.subject : "missing subject"}.` } }],
      };
      break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture method" } }) + "\n");
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
