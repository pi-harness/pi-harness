const activeSessions = new WeakSet<object>();

/**
 * Acquire the process-local compaction slot for one native AgentSession.
 *
 * Pi's compact() method does not reject overlapping calls before its first await,
 * so plugins coordinating only with their own instance-local flags can overwrite
 * the SDK's compaction AbortController. The returned release function is
 * idempotent and must stay held until the native compact() promise settles.
 */
export function tryAcquireSessionCompaction(session: object): (() => void) | undefined {
  if (activeSessions.has(session)) return undefined;
  activeSessions.add(session);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSessions.delete(session);
  };
}
