import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentDirectory } from "../src/agent-directory.js";

describe("agentDirectory", () => {
  test("defaults under the home directory and resolves a relative override against the working directory", () => {
    expect(agentDirectory({}, "/workdir")).toMatch(/[/\\]\.pi[/\\]agent$/u);
    expect(agentDirectory({ PI_CODING_AGENT_DIR: "agent-state" }, "/workdir")).toBe(join("/workdir", "agent-state"));
  });

  test("falls back to the compatibility alias when the upstream variable is exported but blank", () => {
    // Both variables being present is not what decides this: a shell that exports PI_CODING_AGENT_DIR without a value still leaves PI_AGENT_DIR as the only usable answer, and a store that silently moved to the default would take the credentials with it.
    expect(agentDirectory({ PI_CODING_AGENT_DIR: "/upstream", PI_AGENT_DIR: "/legacy" }, "/workdir")).toBe("/upstream");
    expect(agentDirectory({ PI_CODING_AGENT_DIR: "", PI_AGENT_DIR: "/legacy" }, "/workdir")).toBe("/legacy");
    expect(agentDirectory({ PI_CODING_AGENT_DIR: "   ", PI_AGENT_DIR: "/legacy" }, "/workdir")).toBe("/legacy");
  });
});
