export interface SessionNavigationTarget {
  readonly sessionFile?: string;
}

export interface SessionNavigationRefs {
  readonly intent: { current: number };
  readonly pending: { current: { intent: number; path?: string; accepted: boolean } | undefined };
  readonly queue: { current: Promise<void> };
}

export interface EnqueueSessionNavigationInput<T extends SessionNavigationTarget> {
  readonly path: string;
  readonly refs: SessionNavigationRefs;
  readonly getSession: () => Promise<T>;
  readonly openSession: (path: string) => Promise<T>;
  readonly onAccepted: (session: T) => void | Promise<void>;
  readonly onRejected: (cause: unknown, current: T | undefined) => void;
}

export function enqueueSessionNavigation<T extends SessionNavigationTarget>({
  path,
  refs,
  getSession,
  openSession,
  onAccepted,
  onRejected,
}: EnqueueSessionNavigationInput<T>): Promise<void> {
  const intent = ++refs.intent.current;
  refs.pending.current = { intent, path, accepted: false };
  refs.queue.current = refs.queue.current.then(async () => {
    let current: T | undefined;
    try {
      current = await getSession();
      if (refs.pending.current?.intent !== intent) return;
      const opened = path !== current.sessionFile ? await openSession(path) : current;
      if (refs.pending.current?.intent !== intent) return;
      refs.pending.current = { intent, path, accepted: true };
      await onAccepted(opened);
    } catch (cause: unknown) {
      if (refs.pending.current?.intent !== intent) return;
      refs.pending.current = undefined;
      onRejected(cause, current);
    }
  });
  return refs.queue.current;
}
