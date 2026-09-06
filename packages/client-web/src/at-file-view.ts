export interface AtFilePanelView {
  readonly lastFile: { readonly path: string; readonly bytes: number } | null;
  readonly maxBytes: number;
  readonly truncated: boolean;
}

const limits = {
  fileBytes: 256 * 1024,
  pathCharacters: 512,
  pathBytes: 512,
};

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

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = new Set(expected);
  return Object.keys(value).every((key) => keys.has(key));
}

function cleanedPath(value: unknown): { value: string | undefined; altered: boolean } {
  if (typeof value !== "string") return { value: undefined, altered: true };
  const sanitized = value.replaceAll(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ").trim();
  const codePoints = [...sanitized];
  const cleaned = codePoints.length > limits.pathCharacters ? codePoints.slice(0, limits.pathCharacters).join("") : sanitized;
  if (cleaned === "" || new TextEncoder().encode(cleaned).byteLength > limits.pathBytes) return { value: undefined, altered: true };
  return { value: cleaned, altered: cleaned !== value };
}

export function atFilePanelView(data: unknown): AtFilePanelView {
  const source = ownDataRecord(data);
  const lastFileSource = source?.lastFile === null ? null : ownDataRecord(source?.lastFile);
  const path = lastFileSource === null ? undefined : cleanedPath(lastFileSource?.path);
  const bytes = lastFileSource === null ? undefined : lastFileSource?.bytes;
  const lastFileValid =
    lastFileSource === null ||
    (lastFileSource !== undefined &&
      path?.value !== undefined &&
      typeof bytes === "number" &&
      Number.isSafeInteger(bytes) &&
      bytes >= 0 &&
      bytes <= limits.fileBytes &&
      hasOnlyKeys(lastFileSource, ["path", "bytes"]));
  return {
    lastFile: lastFileValid && lastFileSource !== null && path?.value !== undefined && typeof bytes === "number" ? { path: path.value, bytes } : null,
    maxBytes: limits.fileBytes,
    truncated:
      source === undefined ||
      !hasOnlyKeys(source, ["lastFile", "maxBytes"]) ||
      source.maxBytes !== limits.fileBytes ||
      !lastFileValid ||
      path?.altered === true,
  };
}
