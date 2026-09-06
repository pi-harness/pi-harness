export interface DependencyConflictView {
  readonly name: string;
  readonly constraints: readonly string[];
}

export interface DependencyCheckerPanelView {
  readonly manifest: string;
  readonly ecosystem: "npm" | "python";
  readonly declared: number;
  readonly installed: number;
  readonly scanLimit: number;
  readonly missingCount: number;
  readonly optionalMissingCount: number;
  readonly invalidCount: number;
  readonly conflictCount: number;
  readonly unresolvedCount: number;
  readonly missing: readonly string[];
  readonly optionalMissing: readonly string[];
  readonly invalid: readonly string[];
  readonly conflicts: readonly DependencyConflictView[];
  readonly unresolved: readonly DependencyConflictView[];
  readonly truncated: boolean;
}

const limits = {
  declarations: 2_000,
  manifestCharacters: 1_024,
  itemCharacters: 256,
  conflictConstraints: 64,
  visibleItems: 20,
  visibleConflicts: 6,
  visibleConstraints: 8,
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

function ownDataArray(value: unknown, maximum: number): { values: unknown[]; altered: boolean } | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return undefined;
    const count = Math.min(length.value as number, maximum);
    const values: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      values.push(descriptor.value);
    }
    return { values, altered: length.value > maximum };
  } catch {
    return undefined;
  }
}

function expectedKeys(source: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(source).every((key) => expected.has(key));
}

function boundedCount(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function cleanedText(value: unknown, maximum: number): { value: string | undefined; altered: boolean } {
  if (typeof value !== "string") return { value: undefined, altered: true };
  const sanitized = value.replaceAll(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ").trim();
  const codePoints = [...sanitized];
  const cleaned = codePoints.length > maximum ? codePoints.slice(0, maximum).join("") : sanitized;
  return { value: cleaned === "" ? undefined : cleaned, altered: cleaned !== value };
}

function textList(value: unknown): { values: string[]; altered: boolean } {
  const parsed = ownDataArray(value, limits.declarations);
  if (parsed === undefined) return { values: [], altered: true };
  const values: string[] = [];
  let altered = parsed.altered;
  for (const item of parsed.values) {
    const text = cleanedText(item, limits.itemCharacters);
    altered ||= text.altered;
    if (text.value === undefined) altered = true;
    else values.push(text.value);
  }
  return { values, altered };
}

function conflictList(value: unknown): { values: DependencyConflictView[]; altered: boolean } {
  const parsed = ownDataArray(value, limits.declarations);
  if (parsed === undefined) return { values: [], altered: true };
  const values: DependencyConflictView[] = [];
  let altered = parsed.altered;
  for (const item of parsed.values) {
    const source = ownDataRecord(item);
    if (source === undefined) {
      altered = true;
      continue;
    }
    const name = cleanedText(source.name, limits.itemCharacters);
    const constraints = ownDataArray(source.constraints, limits.conflictConstraints);
    if (name.value === undefined || constraints === undefined) {
      altered = true;
      continue;
    }
    const parsedConstraints: string[] = [];
    altered ||= name.altered || constraints.altered || !expectedKeys(source, ["name", "constraints"]);
    for (const constraint of constraints.values) {
      const text = cleanedText(constraint, limits.itemCharacters);
      altered ||= text.altered;
      if (text.value === undefined) altered = true;
      else parsedConstraints.push(text.value);
    }
    if (parsedConstraints.length === 0) {
      altered = true;
      continue;
    }
    if (parsedConstraints.length > limits.visibleConstraints) altered = true;
    values.push({ name: name.value, constraints: parsedConstraints.slice(0, limits.visibleConstraints) });
  }
  return { values, altered };
}

function valuesAreUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function dependencyCheckerPanelView(data: unknown): DependencyCheckerPanelView {
  const root = ownDataRecord(data);
  const report = root === undefined ? undefined : ownDataRecord(root.report);
  const source = report ?? {};
  const manifest = cleanedText(source.manifest, limits.manifestCharacters);
  const missing = textList(source.missing);
  const optionalMissing = textList(source.optionalMissing);
  const invalid = textList(source.invalid);
  const conflicts = conflictList(source.conflicts);
  const unresolved = conflictList(source.unresolved);
  const declared = boundedCount(source.declared, limits.declarations);
  const installed = boundedCount(source.installed, limits.declarations);
  const issueCount = missing.values.length + optionalMissing.values.length + invalid.values.length;
  const recordsDistinct =
    valuesAreUnique([...missing.values, ...optionalMissing.values]) &&
    valuesAreUnique([...conflicts.values.map((conflict) => conflict.name), ...unresolved.values.map((conflict) => conflict.name)]);
  let countsValid = false;
  if (
    declared !== undefined &&
    installed !== undefined &&
    installed <= declared &&
    conflicts.values.length <= declared &&
    unresolved.values.length <= declared
  ) {
    if (source.ecosystem === "npm") countsValid = installed + issueCount === declared;
    else if (source.ecosystem === "python")
      countsValid =
        optionalMissing.values.length === 0 && installed + missing.values.length === declared && declared + invalid.values.length <= limits.declarations;
  }
  const classifiedCount = missing.values.length + optionalMissing.values.length + (source.ecosystem === "python" ? 0 : invalid.values.length);
  const safeDeclared =
    countsValid && declared !== undefined
      ? declared
      : Math.min(limits.declarations, Math.max(classifiedCount, conflicts.values.length, unresolved.values.length));
  const safeInstalled = countsValid && installed !== undefined ? installed : 0;
  const contractAltered =
    root === undefined ||
    report === undefined ||
    !expectedKeys(root, ["report"]) ||
    !expectedKeys(source, ["manifest", "ecosystem", "declared", "installed", "scanLimit", "missing", "optionalMissing", "invalid", "conflicts", "unresolved"]);
  return {
    manifest: manifest.value ?? "package.json",
    ecosystem: source.ecosystem === "python" ? "python" : "npm",
    declared: safeDeclared,
    installed: safeInstalled,
    scanLimit: limits.declarations,
    missingCount: missing.values.length,
    optionalMissingCount: optionalMissing.values.length,
    invalidCount: invalid.values.length,
    conflictCount: conflicts.values.length,
    unresolvedCount: unresolved.values.length,
    missing: missing.values.slice(0, limits.visibleItems),
    optionalMissing: optionalMissing.values.slice(0, limits.visibleItems),
    invalid: invalid.values.slice(0, limits.visibleItems),
    conflicts: conflicts.values.slice(0, limits.visibleConflicts),
    unresolved: unresolved.values.slice(0, limits.visibleConflicts),
    truncated:
      contractAltered ||
      manifest.altered ||
      (source.ecosystem !== "npm" && source.ecosystem !== "python") ||
      !countsValid ||
      source.scanLimit !== limits.declarations ||
      !recordsDistinct ||
      missing.altered ||
      optionalMissing.altered ||
      invalid.altered ||
      conflicts.altered ||
      unresolved.altered ||
      missing.values.length > limits.visibleItems ||
      optionalMissing.values.length > limits.visibleItems ||
      invalid.values.length > limits.visibleItems ||
      conflicts.values.length > limits.visibleConflicts ||
      unresolved.values.length > limits.visibleConflicts,
  };
}
