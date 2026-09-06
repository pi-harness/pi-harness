const defaults = {
  directoryEntries: 4_096,
  sessionBytes: 4_194_304,
  sessions: 100,
  allowedSessions: 500,
  readConcurrency: 8,
  contentParts: 1_000,
  previewCharacters: 500,
  panelItems: 50,
  toolItems: 100,
  queryCharacters: 120,
  sessionIdCharacters: 256,
  sessionNameCharacters: 256,
  sessionPathCharacters: 4_096,
  statusErrorCharacters: 2_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function limit(value: unknown, fallback: number, maximum = fallback): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : fallback;
}

function count(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function text(value: unknown, maximum: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replaceAll("\0", "�").slice(0, maximum) || fallback;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function status(value: unknown, errorLimit: number) {
  if (!isRecord(value)) return { state: "idle" as const, at: null, error: null };
  const state = value.state === "running" || value.state === "completed" || value.state === "failed" || value.state === "cancelled" ? value.state : "idle";
  const at = timestamp(value.at);
  if ((state === "completed" || state === "failed" || state === "cancelled") && at === null) return { state: "idle" as const, at: null, error: null };
  const error = state === "failed" || state === "cancelled" ? text(value.error, errorLimit) || null : null;
  return { state, at, error };
}

export function recallUnreadPanelView(data: unknown) {
  const source = isRecord(data) ? data : {};
  const rawLimits = isRecord(source.limits) ? source.limits : {};
  const allowedSessions = limit(rawLimits.allowedSessions, defaults.allowedSessions);
  const limits = {
    directoryEntries: limit(rawLimits.directoryEntries, defaults.directoryEntries),
    sessionBytes: limit(rawLimits.sessionBytes, defaults.sessionBytes),
    sessions: limit(rawLimits.sessions, Math.min(defaults.sessions, allowedSessions), allowedSessions),
    allowedSessions,
    readConcurrency: limit(rawLimits.readConcurrency, defaults.readConcurrency),
    contentParts: limit(rawLimits.contentParts, defaults.contentParts),
    previewCharacters: limit(rawLimits.previewCharacters, defaults.previewCharacters),
    panelItems: limit(rawLimits.panelItems, defaults.panelItems),
    toolItems: limit(rawLimits.toolItems, defaults.toolItems),
    queryCharacters: limit(rawLimits.queryCharacters, defaults.queryCharacters),
    sessionIdCharacters: limit(rawLimits.sessionIdCharacters, defaults.sessionIdCharacters),
    sessionNameCharacters: limit(rawLimits.sessionNameCharacters, defaults.sessionNameCharacters),
    sessionPathCharacters: limit(rawLimits.sessionPathCharacters, defaults.sessionPathCharacters),
    statusErrorCharacters: limit(rawLimits.statusErrorCharacters, defaults.statusErrorCharacters),
  };
  const items = (Array.isArray(source.items) ? source.items : []).slice(0, limits.panelItems).map((value) => {
    const item = isRecord(value) ? value : {};
    const id = text(item.id, limits.sessionIdCharacters, "unknown");
    return {
      id,
      path: text(item.path, limits.sessionPathCharacters),
      cwd: text(item.cwd, limits.sessionPathCharacters),
      name: text(item.name, limits.sessionNameCharacters, id),
      modified: timestamp(item.modified),
      messageCount: count(item.messageCount, limits.sessionBytes),
      message: text(item.message, limits.previewCharacters),
    };
  });
  const rawInventory = isRecord(source.inventory) ? source.inventory : {};
  return {
    scans: count(source.scans, Number.MAX_SAFE_INTEGER),
    total: count(source.total, limits.sessions),
    items,
    status: status(source.status, limits.statusErrorCharacters),
    inventory: {
      available: count(rawInventory.available, limits.directoryEntries),
      candidates: count(rawInventory.candidates, limits.directoryEntries),
      scanned: count(rawInventory.scanned, limits.sessions),
      unread: count(rawInventory.unread, limits.sessions),
      shown: count(rawInventory.shown, limits.panelItems),
      truncated: rawInventory.truncated === true,
      discoveryTruncated: rawInventory.discoveryTruncated === true,
      scanTruncated: rawInventory.scanTruncated === true,
      displayTruncated: rawInventory.displayTruncated === true,
    },
    limits,
  };
}
