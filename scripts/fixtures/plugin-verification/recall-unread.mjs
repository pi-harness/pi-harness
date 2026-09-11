import { SessionManager } from '@earendil-works/pi-coding-agent';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { utimesSync } from 'node:fs';
import { resolve } from 'node:path';

const marker = 'RECALL_AUDIT_' + randomUUID().slice(0, 8);
const items = [];
for (let index = 0; index < 2; index += 1) {
  const manager = SessionManager.create(process.cwd(), resolve('.pih-agent/sessions'));
  manager.appendMessage({ role: 'user', content: marker + ' initial request', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'Synthetic initial answer.' }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const message = marker + ' unanswered ' + index + (index === 1 ? ' ' + 'X'.repeat(600) : '');
  manager.appendMessage({ role: 'user', content: message, timestamp: Date.now() });
  const name = marker + ' same title';
  manager.appendSessionInfo(name);
  const path = manager.getSessionFile();
  if (path === undefined) throw new Error('Fixture session was not persisted');
  // Deterministic newest-first order without sleeping or touching other files.
  const modified = new Date(Date.now() + 5000 + index * 1000);
  utimesSync(path, modified, modified);
  items.push({id: manager.getSessionId(), path, name, message: message.slice(0, 500)});
}
process.stdout.write(JSON.stringify({marker, items: items.reverse()}));
