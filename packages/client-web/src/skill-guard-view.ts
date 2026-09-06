const defaults = {
  queryCharacters: 120,
  skillBytes: 131_072,
  skills: 50,
  panelReports: 20,
  nameCharacters: 64,
  sourceCharacters: 128,
  pathCharacters: 4_096,
  statusErrorCharacters: 2_000,
  findingsPerSkill: 6,
  findingCodeCharacters: 64,
  findingMessageCharacters: 256,
  score: 28,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function limit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= fallback ? value : fallback;
}

function count(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function boundedString(value: unknown, maximum: number, fallback = ""): string {
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

function scanStatus(value: unknown, errorLimit: number) {
  if (!isRecord(value)) return { state: "idle" as const, at: null, error: null };
  const state = value.state === "running" || value.state === "completed" || value.state === "failed" || value.state === "cancelled" ? value.state : "idle";
  const at = timestamp(value.at);
  if ((state === "completed" || state === "failed" || state === "cancelled") && at === null) return { state: "idle" as const, at: null, error: null };
  const error = state === "failed" || state === "cancelled" ? boundedString(value.error, errorLimit) || null : null;
  return { state, at, error };
}

export function skillGuardPanelView(data: unknown) {
  const source = isRecord(data) ? data : {};
  const rawLimits = isRecord(source.limits) ? source.limits : {};
  const limits = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, limit(rawLimits[key], fallback)])) as unknown as typeof defaults;
  const reports = (Array.isArray(source.reports) ? source.reports : []).slice(0, limits.panelReports).map((value) => {
    const report = isRecord(value) ? value : {};
    const risk = report.risk === "safe" || report.risk === "review" || report.risk === "blocked" ? report.risk : "review";
    const findings = (Array.isArray(report.findings) ? report.findings : []).slice(0, limits.findingsPerSkill).map((value) => {
      const finding = isRecord(value) ? value : {};
      return {
        code: boundedString(finding.code, limits.findingCodeCharacters, "finding"),
        severity: finding.severity === "high" ? ("high" as const) : ("medium" as const),
        message: boundedString(finding.message, limits.findingMessageCharacters),
      };
    });
    return {
      name: boundedString(report.name, limits.nameCharacters, "unknown"),
      risk,
      score: count(report.score, limits.score),
      findings,
      path: boundedString(report.path, limits.pathCharacters),
      source: boundedString(report.source, limits.sourceCharacters, "unknown"),
      scannedBytes: count(report.scannedBytes, limits.skillBytes),
    };
  });
  const rawInventory = isRecord(source.inventory) ? source.inventory : {};
  return {
    scans: count(source.scans, Number.MAX_SAFE_INTEGER),
    total: count(source.total, limits.skills),
    blocked: count(source.blocked, limits.skills),
    review: count(source.review, limits.skills),
    reports,
    status: scanStatus(source.status, limits.statusErrorCharacters),
    inventory: {
      available: count(rawInventory.available, Number.MAX_SAFE_INTEGER),
      scanned: count(rawInventory.scanned, limits.skills),
      shown: count(rawInventory.shown, limits.panelReports),
      truncated: rawInventory.truncated === true,
      scanTruncated: rawInventory.scanTruncated === true,
      displayTruncated: rawInventory.displayTruncated === true,
    },
    limits,
  };
}
