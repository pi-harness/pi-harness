export type SqlLensStatusState = "idle" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface SqlLensPanelView {
  readonly status: { readonly state: SqlLensStatusState; readonly at: string | null; readonly error: string | null };
  readonly timeoutMs: number;
  readonly latest: {
    readonly cwd: string;
    readonly database: string;
    readonly query: string;
    readonly columns: readonly string[];
    readonly rows: readonly Record<string, unknown>[];
    readonly rowInventory: {
      readonly scanned: number;
      readonly returned: number;
      readonly shown: number;
      readonly truncated: boolean;
      readonly displayLimit: number;
    };
  } | null;
  readonly limits: typeof limitsDefaults;
  readonly malformed: boolean;
}

const visibleRows = 12;
const visibleColumns = 32;
const maxColumnName = 512;
const maxDisplayString = 16_384;
const maxStatusError = 2_000;
const visibleStatusError = 500;
const defaults = {
  timeoutMs: 5_000,
} as const;
const limitsDefaults = {
  queryLength: 65_536,
  databaseBytes: 268_435_456,
  rows: 100,
  columns: 128,
  stringLength: 16_384,
  resultBytes: 1_048_576,
  blobPreviewBytes: 256,
  panelRows: 20,
} as const;
const rootKeys = new Set(["status", "timeoutMs", "latest", "limits"]);
const statusKeys = new Set(["state", "at", "error"]);
const latestKeys = new Set(["cwd", "database", "query", "columns", "rows", "truncated", "scannedRows", "rowInventory"]);
const rowInventoryKeys = new Set(["scanned", "returned", "shown", "truncated", "displayLimit"]);
const cellKeys = new Set(["type", "bytes", "previewBase64", "truncated"]);
const limitKeys = new Set(Object.keys(limitsDefaults));
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function hasExactly(source: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const own = Object.keys(source);
  return own.length === keys.size && own.every((key) => keys.has(key));
}

function safeInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function safeText(value: unknown, maximum: number, allowEmpty = false, allowLineBreaks = false): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return undefined;
  for (const character of value) {
    if (unsafeUnicode.test(character) && !(allowLineBreaks && (character === "\t" || character === "\n" || character === "\r"))) return undefined;
  }
  if (value.length > maximum) return undefined;
  return value;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function ownDataArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= (length as number) || String(Number(key)) !== key),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function statusView(value: unknown): SqlLensPanelView["status"] | undefined {
  const source = ownDataRecord(value, statusKeys);
  if (source === undefined) return undefined;
  if (source.state === "idle" && hasExactly(source, new Set(["state"]))) return { state: "idle", at: null, error: null };
  if (source.state === "running" && hasExactly(source, new Set(["state"]))) return { state: "running", at: null, error: null };
  const at = timestamp(source.at);
  if (source.state === "completed" && at !== undefined && hasExactly(source, new Set(["state", "at"]))) return { state: "completed", at, error: null };
  if ((source.state === "failed" || source.state === "cancelled") && at !== undefined && hasExactly(source, statusKeys)) {
    const error = safeText(source.error, maxStatusError);
    if (error !== undefined) return { state: source.state, at, error: [...error].slice(0, visibleStatusError).join("") };
  }
  return undefined;
}

function cellView(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return safeText(value, maxDisplayString, true, true);
  const source = ownDataRecord(value, cellKeys);
  if (
    source === undefined ||
    !hasExactly(source, cellKeys) ||
    source.type !== "blob" ||
    typeof source.truncated !== "boolean" ||
    typeof source.previewBase64 !== "string" ||
    source.previewBase64.length > 344 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source.previewBase64)
  )
    return undefined;
  const bytes = safeInteger(source.bytes, Number.MAX_SAFE_INTEGER);
  return bytes === undefined ? undefined : { type: "blob", bytes, previewBase64: source.previewBase64, truncated: source.truncated };
}

function latestView(value: unknown): SqlLensPanelView["latest"] | undefined {
  const source = ownDataRecord(value, latestKeys);
  if (source === undefined || !hasExactly(source, latestKeys)) return undefined;
  const cwd = safeText(source.cwd, 4_096);
  const database = safeText(source.database, 4_096);
  const query = safeText(source.query, limitsDefaults.queryLength, false, true);
  const columnsRaw = ownDataArray(source.columns, limitsDefaults.columns);
  const rowsRaw = ownDataArray(source.rows, limitsDefaults.panelRows);
  const scannedRows = safeInteger(source.scannedRows, Number.MAX_SAFE_INTEGER);
  const inventory = ownDataRecord(source.rowInventory, rowInventoryKeys);
  if (
    cwd === undefined ||
    database === undefined ||
    query === undefined ||
    columnsRaw === undefined ||
    rowsRaw === undefined ||
    scannedRows === undefined ||
    inventory === undefined ||
    !hasExactly(inventory, rowInventoryKeys) ||
    typeof source.truncated !== "boolean"
  )
    return undefined;
  const columns: string[] = [];
  for (const value of columnsRaw) {
    const column = safeText(value, maxColumnName);
    if (column === undefined) return undefined;
    columns.push(column);
  }
  if (columns.length === 0 || new Set(columns).size !== columns.length) return undefined;
  const scanned = safeInteger(inventory.scanned, Number.MAX_SAFE_INTEGER);
  // `returned` counts the rows the query produced (up to the query row cap), while `shown` counts the rows the panel payload actually carries (up to the panel cap).
  const returned = safeInteger(inventory.returned, limitsDefaults.rows);
  const shown = safeInteger(inventory.shown, limitsDefaults.panelRows);
  if (
    scanned === undefined ||
    returned === undefined ||
    shown === undefined ||
    scanned !== scannedRows ||
    shown !== rowsRaw.length ||
    shown !== Math.min(returned, limitsDefaults.panelRows) ||
    returned > scanned ||
    inventory.displayLimit !== limitsDefaults.panelRows ||
    typeof inventory.truncated !== "boolean"
  )
    return undefined;
  const rows: Record<string, unknown>[] = [];
  for (const rawRow of rowsRaw) {
    const row = ownDataRecord(rawRow, new Set(columns));
    if (row === undefined || Object.keys(row).length !== columns.length) return undefined;
    const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const column of columns) {
      const cell = cellView(row[column]);
      if (cell === undefined) return undefined;
      normalized[column] = cell;
    }
    rows.push(normalized);
  }
  const visible = rows.slice(0, visibleRows);
  return {
    cwd,
    database,
    query,
    columns: columns.slice(0, visibleColumns),
    rows: visible,
    rowInventory: {
      scanned,
      returned,
      shown: visible.length,
      truncated: source.truncated || inventory.truncated || rows.length !== returned || rows.length > visible.length || columns.length > visibleColumns,
      displayLimit: limitsDefaults.panelRows,
    },
  };
}

function validLimits(value: unknown): value is typeof limitsDefaults {
  const source = ownDataRecord(value, limitKeys);
  return source !== undefined && hasExactly(source, limitKeys) && Object.entries(limitsDefaults).every(([key, expected]) => source[key] === expected);
}

function malformedView(): SqlLensPanelView {
  return {
    status: { state: "unknown", at: null, error: null },
    timeoutMs: defaults.timeoutMs,
    latest: null,
    malformed: true,
    limits: { ...limitsDefaults },
  };
}

export function sqlLensPanelView(data: unknown): SqlLensPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !hasExactly(source, rootKeys)) return malformedView();
  const timeoutMs = safeInteger(source.timeoutMs, 30_000);
  if (timeoutMs === undefined || timeoutMs < 100 || !validLimits(source.limits)) return malformedView();
  const status = statusView(source.status);
  if (status === undefined) return malformedView();
  const latest = source.latest === null ? null : latestView(source.latest);
  if (latest === undefined || (status.state === "idle" && latest !== null) || (status.state === "completed" && latest === null)) return malformedView();
  return { status, timeoutMs, latest, malformed: false, limits: { ...limitsDefaults } };
}
