// Print bounded runtime progress without dumping tool arguments or file contents.
import process from 'node:process';
import console from 'node:console';

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : {};
}

const origin = process.argv[2] ?? 'http://127.0.0.1:3142';
const duration = Number(process.argv[3] ?? 45);
if (!Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error('Duration must be 1–60 seconds');
/** @type {Map<string, number>} */
const counts = new Map();
const started = Date.now();
let buffer = '';
try {
  const response = await globalThis.fetch(`${origin}/api/events`, { signal: AbortSignal.timeout(duration * 1000) });
  if (!response.ok) throw new Error(`Events HTTP ${response.status}`);
  if (!response.body) throw new Error('Events response has no body');
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!frame.startsWith('data: ')) continue;
      const payload = record(JSON.parse(frame.slice(6)));
      if (payload.type === 'snapshot') continue;
      const event = record(payload.event);
      const kind = record(event.assistantMessageEvent).type ?? event.type ?? payload.type;
      if (typeof kind !== 'string') continue;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (kind === 'tool_execution_start' || kind === 'tool_execution_end' || kind === 'agent_end') {
        console.log(JSON.stringify({ elapsedMs: Date.now() - started, kind, tool: typeof event.toolName === 'string' ? event.toolName : undefined }));
      }
    }
  }
} catch (error) {
  if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
}
console.log(JSON.stringify({ elapsedMs: Date.now() - started, counts: Object.fromEntries(counts) }));
