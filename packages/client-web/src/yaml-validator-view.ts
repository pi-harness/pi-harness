const visibleDiagnostics = 20;
const defaults = {
  fileBytes: 512 * 1024,
  pathCharacters: 4_096,
  documents: 100,
  diagnostics: 1_000,
  panelDiagnostics: 50,
  toolDiagnostics: 50,
  diagnosticMessageCharacters: 2_000,
  statusErrorCharacters: 2_000,
} as const;
const rootTypes = new Set(["empty", "map", "seq", "scalar"]);
const statusStates = new Set(["idle", "running", "completed", "failed", "cancelled"]);

function string(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function integer(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function diagnostic(value: unknown) {
  const record = ownRecord(value);
  if (record === undefined || typeof record.message !== "string") return undefined;
  const code = string(record.code, 128);
  const line = integer(record.line, 1, defaults.fileBytes, 0);
  const column = integer(record.column, 1, defaults.fileBytes, 0);
  return {
    message: record.message.slice(0, defaults.diagnosticMessageCharacters),
    ...(code === "" ? {} : { code }),
    ...(line === 0 ? {} : { line }),
    ...(column === 0 ? {} : { column }),
  };
}

function diagnostics(value: unknown, limit: number) {
  const source = ownArray(value, limit + 8) ?? [];
  return source
    .slice(0, limit + 8)
    .map(diagnostic)
    .filter((entry): entry is NonNullable<ReturnType<typeof diagnostic>> => entry !== undefined)
    .slice(0, limit);
}

function inventory(value: unknown, totalFallback: number, shown: number, clipped: boolean) {
  const source = ownRecord(value) ?? {};
  const total = integer(source.total, shown, 1_000_000, totalFallback);
  return { total, shown, truncated: source.truncated === true || clipped || total > shown };
}

export function yamlValidatorPanelView(data: unknown) {
  const source = ownRecord(data) ?? {};
  const rawLimits = ownRecord(source.limits) ?? {};
  const limits = {
    fileBytes: integer(rawLimits.fileBytes, 1, defaults.fileBytes, defaults.fileBytes),
    pathCharacters: integer(rawLimits.pathCharacters, 1, defaults.pathCharacters, defaults.pathCharacters),
    documents: integer(rawLimits.documents, 1, defaults.documents, defaults.documents),
    diagnostics: integer(rawLimits.diagnostics, 1, defaults.diagnostics, defaults.diagnostics),
    panelDiagnostics: integer(rawLimits.panelDiagnostics, 1, defaults.panelDiagnostics, defaults.panelDiagnostics),
    toolDiagnostics: integer(rawLimits.toolDiagnostics, 1, defaults.toolDiagnostics, defaults.toolDiagnostics),
    diagnosticMessageCharacters: integer(rawLimits.diagnosticMessageCharacters, 1, defaults.diagnosticMessageCharacters, defaults.diagnosticMessageCharacters),
    statusErrorCharacters: integer(rawLimits.statusErrorCharacters, 1, defaults.statusErrorCharacters, defaults.statusErrorCharacters),
  };
  const rawLatest = ownRecord(source.latest);
  const rawErrors = ownArray(rawLatest?.errors, defaults.diagnostics + 8) ?? [];
  const errors = diagnostics(rawErrors, visibleDiagnostics);
  const rawWarnings = ownArray(rawLatest?.warnings, defaults.diagnostics + 8) ?? [];
  const warnings = diagnostics(rawWarnings, Math.max(0, visibleDiagnostics - errors.length));
  const errorCount = integer(rawLatest?.errorCount, errors.length, 1_000_000, rawErrors.length);
  const warningCount = integer(rawLatest?.warningCount, warnings.length, 1_000_000, rawWarnings.length);
  const rawInventory = ownRecord(source.inventory) ?? {};
  const rawStatus = ownRecord(source.status) ?? {};
  const state = typeof rawStatus.state === "string" && statusStates.has(rawStatus.state) ? rawStatus.state : "unknown";
  const at = string(rawStatus.at, 64);
  const error = string(rawStatus.error, limits.statusErrorCharacters);
  return {
    latest:
      rawLatest === undefined
        ? null
        : {
            path: string(rawLatest.path, limits.pathCharacters),
            valid: rawLatest.valid === true,
            bytes: integer(rawLatest.bytes, 0, limits.fileBytes, 0),
            documents: integer(rawLatest.documents, 0, limits.documents, 0),
            rootType: typeof rawLatest.rootType === "string" && rootTypes.has(rawLatest.rootType) ? rawLatest.rootType : "unknown",
            errorCount,
            warningCount,
            diagnosticsTruncated:
              rawLatest.diagnosticsTruncated === true || errorCount > errors.length || warningCount > warnings.length || rawErrors.length > errors.length,
            errors,
            warnings,
          },
    status: { state, ...(at === "" ? {} : { at }), ...(error === "" ? {} : { error }) },
    inventory: {
      errors: inventory(rawInventory.errors, errorCount, errors.length, rawErrors.length > errors.length),
      warnings: inventory(rawInventory.warnings, warningCount, warnings.length, rawWarnings.length > warnings.length),
    },
    limits,
  };
}
import { ownArray, ownRecord } from "./panel-safe.js";
