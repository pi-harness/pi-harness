export type TestHarnessStatus = "passed" | "failed" | "timed-out" | "cancelled";

export interface TestHarnessRunView {
  readonly script: string;
  readonly command: string;
  readonly status: TestHarnessStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly output: string;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
  readonly outputSanitized: boolean;
}

export interface TestHarnessPanelView {
  readonly allowedScripts: readonly string[];
  readonly latest: TestHarnessRunView | null;
  readonly limits: { readonly timeoutMs: number; readonly outputBytes: number };
  readonly truncated: boolean;
}

const allowedScripts = ["test", "build", "format:check", "lint", "typecheck"] as const;
const outputBytes = 12 * 1024;
const defaultTimeoutMs = 120_000;
const minimumTimeoutMs = 100;
const maximumTimeoutMs = 600_000;
const maximumDurationMs = maximumTimeoutMs + 10_000;

function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return undefined;
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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  return keys.length === expected.length && keys.every((key) => allowed.has(key));
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function exactAllowedScripts(value: unknown): boolean {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== allowedScripts.length + 1 || keys.some((key) => typeof key !== "string")) return false;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length === undefined || !("value" in length) || length.value !== allowedScripts.length) return false;
    return allowedScripts.every((script, index) => {
      const descriptor = descriptors[String(index)];
      return descriptor !== undefined && "value" in descriptor && descriptor.value === script;
    });
  } catch {
    return false;
  }
}

function replaceUnsafeControls(value: string): string {
  let output = "";
  for (const codePoint of value) {
    const code = codePoint.codePointAt(0)!;
    const safeCharacter = code === 9 || code === 10 || (code >= 32 && code !== 127 && (code < 128 || code > 159) && !/[\p{Cf}\p{Cs}]/u.test(codePoint));
    output += safeCharacter ? codePoint : "�";
  }
  return output;
}

function boundedOutput(value: unknown): { value: string | undefined; altered: boolean } {
  if (typeof value !== "string") return { value: undefined, altered: true };
  const sample = value.slice(0, outputBytes * 2 + 1);
  const sanitized = replaceUnsafeControls(sample.replaceAll(/\r\n?/gu, "\n"));
  let bytes = 0;
  let output = "";
  for (const codePoint of sanitized) {
    const size = new TextEncoder().encode(codePoint).byteLength;
    if (bytes + size > outputBytes) break;
    bytes += size;
    output += codePoint;
  }
  return { value: output, altered: sample.length !== value.length || output !== value };
}

function signalValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && /^SIG[A-Z0-9]{1,24}$/u.test(value) ? value : undefined;
}

function runView(value: unknown): { value: TestHarnessRunView | null; altered: boolean } {
  if (value === null) return { value: null, altered: false };
  const source = ownDataRecord(value);
  if (
    source === undefined ||
    !hasExactKeys(source, ["script", "command", "status", "exitCode", "signal", "durationMs", "output", "outputBytes", "outputTruncated", "outputSanitized"])
  )
    return { value: null, altered: true };
  const script = source.script;
  const status = source.status;
  const exitCode = source.exitCode;
  const signal = signalValue(source.signal);
  const output = boundedOutput(source.output);
  if (
    typeof script !== "string" ||
    !allowedScripts.includes(script as (typeof allowedScripts)[number]) ||
    source.command !== `npm run ${script}` ||
    (status !== "passed" && status !== "failed" && status !== "timed-out" && status !== "cancelled") ||
    !safeInteger(source.durationMs, 0, maximumDurationMs) ||
    !safeInteger(source.outputBytes, 0, Number.MAX_SAFE_INTEGER) ||
    typeof source.outputTruncated !== "boolean" ||
    typeof source.outputSanitized !== "boolean" ||
    signal === undefined ||
    output.value === undefined
  )
    return { value: null, altered: true };
  const validOutcome =
    (status === "passed" && exitCode === 0 && signal === null) ||
    (status === "failed" && (exitCode === null || (safeInteger(exitCode, 1, 255) && exitCode !== 0 && signal === null))) ||
    ((status === "timed-out" || status === "cancelled") && exitCode === null);
  const renderedBytes = new TextEncoder().encode(output.value).byteLength;
  // A truncated run whose raw counter is below the cap has to show a full cap's worth of output, because the only way to truncate that little raw input is decode-time or sanitisation-time expansion, and both stop exactly at the cap. `raw.toString("utf8")` turns each invalid byte into a three-byte U+FFFD before the sanitiser ever runs, so that expansion can happen with `outputSanitized` still false. The slack is one code point, at most four bytes.
  const fillsOutputCap = renderedBytes + 4 > outputBytes;
  // `outputBytes` counts raw process bytes while truncation is decided after decoding and sanitisation, so it is an upper bound on nothing and a lower bound only for runs the byte counter itself cut off.
  const validAccounting = source.outputTruncated
    ? source.outputBytes >= outputBytes || source.outputSanitized || fillsOutputCap
    : source.outputBytes <= outputBytes && (source.outputSanitized || source.outputBytes === renderedBytes);
  if (!validOutcome || !validAccounting) return { value: null, altered: true };
  return {
    value: {
      script,
      command: source.command,
      status,
      exitCode,
      signal,
      durationMs: source.durationMs,
      output: output.value,
      outputBytes: source.outputBytes,
      outputTruncated: source.outputTruncated,
      outputSanitized: source.outputSanitized,
    },
    altered: output.altered,
  };
}

export function testHarnessPanelView(data: unknown): TestHarnessPanelView {
  const source = ownDataRecord(data);
  const limitsSource = ownDataRecord(source?.limits);
  const timeoutMs = safeInteger(limitsSource?.timeoutMs, minimumTimeoutMs, maximumTimeoutMs) ? limitsSource.timeoutMs : defaultTimeoutMs;
  const limitsValid = limitsSource !== undefined && hasExactKeys(limitsSource, ["timeoutMs", "outputBytes"]) && limitsSource.outputBytes === outputBytes;
  const scriptsValid = exactAllowedScripts(source?.allowedScripts);
  const latest = runView(source?.latest);
  return {
    allowedScripts: [...allowedScripts],
    latest: latest.value,
    limits: { timeoutMs, outputBytes },
    truncated: source === undefined || !hasExactKeys(source, ["allowedScripts", "latest", "limits"]) || !limitsValid || !scriptsValid || latest.altered,
  };
}
