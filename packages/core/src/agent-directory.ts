import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolves Pi's native agent directory variable, with PI_AGENT_DIR retained as a compatibility alias. */
export function agentDirectory(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim() || env.PI_AGENT_DIR?.trim();
  return configured === undefined || configured.length === 0 ? join(homedir(), ".pi", "agent") : resolve(cwd, configured);
}
