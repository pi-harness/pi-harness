export interface DockerSandboxRunView {
  readonly image: string;
  readonly command: readonly string[];
  readonly commandCount: number;
  readonly write: boolean;
  readonly exitCode: number;
  readonly status: "completed" | "failed" | "timed_out";
  readonly output: string;
  readonly truncated: boolean;
}

export interface DockerSandboxDefaultsView {
  readonly image: string;
  readonly pull: string;
  readonly network: string;
  readonly rootFilesystem: string;
  readonly workspace: string;
  readonly memory: string;
  readonly cpus: number;
  readonly pids: number;
  readonly timeoutMs: number;
}

export interface DockerSandboxPanelView {
  readonly latest: DockerSandboxRunView | null;
  readonly defaults: DockerSandboxDefaultsView;
  readonly malformed: boolean;
}

const defaultSettings = {
  image: "alpine:3.20",
  pull: "never",
  network: "none",
  rootFilesystem: "read-only",
  workspace: "read-only",
  memory: "512m",
  cpus: 1,
  pids: 256,
  timeoutMs: 120_000,
} as const;
const rootKeys = new Set(["latest", "defaults"]);
const latestKeys = new Set(["image", "command", "write", "exitCode", "status", "output"]);
const defaultsKeys = new Set(Object.keys(defaultSettings));
const maxArguments = 128;
const maxImageInputLength = 4_096;
const maxArgumentInputLength = 16_384;
const maxOutputInputLength = 12_000;
const maxVisibleArguments = 16;
const maxVisibleArgumentLength = 256;
const maxVisibleOutputLength = 4_000;
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

function ownDataArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const lengthDescriptor = descriptors.length;
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) return undefined;
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

function safeText(value: unknown, maximum: number, allowEmpty = false, allowLineBreaks = false): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return undefined;
  for (const character of value) {
    if (unsafeUnicode.test(character) && !(allowLineBreaks && (character === "\t" || character === "\n" || character === "\r"))) return undefined;
  }
  if ([...value].length > maximum || new TextEncoder().encode(value).byteLength > maximum) return undefined;
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function displayText(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function runView(value: unknown): DockerSandboxRunView | undefined {
  const source = ownDataRecord(value, latestKeys);
  if (source === undefined || !hasExactly(source, latestKeys)) return undefined;
  const image = safeText(source.image, maxImageInputLength);
  const commandRaw = ownDataArray(source.command, maxArguments);
  const output = safeText(source.output, maxOutputInputLength, true, true);
  const exitCode = safeInteger(source.exitCode, -2_147_483_648, 2_147_483_647);
  if (
    image === undefined ||
    commandRaw === undefined ||
    commandRaw.length === 0 ||
    output === undefined ||
    exitCode === undefined ||
    typeof source.write !== "boolean" ||
    (source.status !== "completed" && source.status !== "failed" && source.status !== "timed_out")
  )
    return undefined;
  const command: string[] = [];
  for (const argument of commandRaw) {
    const text = safeText(argument, maxArgumentInputLength);
    if (text === undefined || text.length === 0) return undefined;
    command.push(text);
  }
  return {
    image: displayText(image, 512),
    command: command.slice(0, maxVisibleArguments).map((argument) => displayText(argument, maxVisibleArgumentLength)),
    commandCount: command.length,
    write: source.write,
    exitCode,
    status: source.status,
    output: displayText(output, maxVisibleOutputLength),
    truncated:
      image.length > 512 ||
      command.length > maxVisibleArguments ||
      command.some((argument) => argument.length > maxVisibleArgumentLength) ||
      output.length > maxVisibleOutputLength,
  };
}

function defaultsView(value: unknown): DockerSandboxDefaultsView | undefined {
  const source = ownDataRecord(value, defaultsKeys);
  if (source === undefined || !hasExactly(source, defaultsKeys)) return undefined;
  for (const [key, expected] of Object.entries(defaultSettings)) if (source[key] !== expected) return undefined;
  return { ...defaultSettings };
}

function malformedView(): DockerSandboxPanelView {
  return { latest: null, defaults: { ...defaultSettings }, malformed: true };
}

export function dockerSandboxPanelView(data: unknown): DockerSandboxPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || !hasExactly(source, rootKeys)) return malformedView();
  const defaults = defaultsView(source.defaults);
  if (defaults === undefined) return malformedView();
  if (source.latest === null) return { latest: null, defaults, malformed: false };
  const latest = runView(source.latest);
  return latest === undefined ? malformedView() : { latest, defaults, malformed: false };
}
