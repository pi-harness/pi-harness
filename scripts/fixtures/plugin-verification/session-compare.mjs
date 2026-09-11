import { SessionManager } from '@earendil-works/pi-coding-agent';
import process from 'node:process';
import { resolve } from 'node:path';

// Dedicated synthetic sessions; never open or modify existing transcripts.
const directory = resolve('.pih-agent/sessions');
/** @type {Record<string, {id: string, path: string | undefined}>} */
const sessions = {};
for (const side of ['left', 'right']) {
  const manager = SessionManager.create(process.cwd(), directory);
  manager.appendMessage({ role: 'user', content: 'COMPARE_AUDIT shared request', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: `COMPARE_AUDIT_${side} ` + side.repeat(1_100) }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  manager.appendSessionInfo(`Session Compare Audit ${side}`);
  sessions[side] = { id: manager.getSessionId(), path: manager.getSessionFile() };
}
process.stdout.write(JSON.stringify(sessions));
