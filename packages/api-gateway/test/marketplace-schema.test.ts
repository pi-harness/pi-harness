import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { MARKETPLACE_PLUGINS } from "../src/marketplace.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const schemaPath = resolve(repositoryRoot, "docs/marketplace-entry.schema.json");
const entriesRoot = resolve(import.meta.dirname, "../src/marketplace-entries");

type Schema = Record<string, unknown>;
type JsonType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

// The repository has no JSON Schema validator dependency (ajv is only a transitive draft-07 build), so this test interprets exactly the keyword subset the published schema uses. Any keyword outside this set fails loudly instead of being silently ignored, so a schema edit cannot escape the check.
const supportedKeywords = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "required",
  "additionalProperties",
  "properties",
  "pattern",
  "minLength",
  "enum",
  "const",
  "items",
  "minItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "if",
  "then",
  "else",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value as JsonType;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validate(schema: Schema, value: unknown, path = "$"): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) throw new Error(`Unsupported schema keyword "${keyword}" at ${path}`);
  }
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const allowed = (Array.isArray(schema.type) ? schema.type : [schema.type]) as JsonType[];
    const actual = jsonType(value);
    if (!allowed.some((type) => type === actual || (type === "number" && actual === "integer")))
      errors.push(`${path}: expected ${allowed.join("|")}, got ${actual}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJson(candidate, value)))
    errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  if ("const" in schema && !sameJson(schema.const, value)) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: ${value} < ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: ${value} > ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: items are not unique`);
    if (isRecord(schema.items)) value.forEach((item, index) => errors.push(...validate(schema.items as Schema, item, `${path}[${index}]`)));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required))
      for (const key of schema.required as string[]) if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    for (const [key, property] of Object.entries(properties)) {
      if (key in value) errors.push(...validate(property as Schema, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push(`${path}: unexpected property "${key}"`);
    }
  }
  if (isRecord(schema.if)) {
    const branch = validate(schema.if, value, path).length === 0 ? schema.then : schema.else;
    if (isRecord(branch)) errors.push(...validate(branch, value, path));
  }
  return errors;
}

function entryFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entryFiles(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  });
}

const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Schema;
const files = entryFiles(entriesRoot).sort();
const readEntry = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const validEntry = (): Record<string, unknown> => readEntry(join(entriesRoot, "official", "agent-teams.json"));
const groupEntry = (): Record<string, unknown> => readEntry(join(entriesRoot, "official", "cordis-group.json"));

describe("marketplace entry schema", () => {
  test("covers every shipped entry file", () => {
    expect(files.length).toBe(MARKETPLACE_PLUGINS.length);
  });

  test.each(files.map((path) => [relative(entriesRoot, path), path] as const))("accepts %s", (_name, path) => {
    expect(validate(schema, readEntry(path))).toEqual([]);
  });

  test("accepts core plugin subpaths and group entries with array config", () => {
    expect(validate(schema, validEntry())).toEqual([]);
    expect(validate(schema, groupEntry())).toEqual([]);
    expect(validate(schema, { ...validEntry(), statistics: { downloads30d: 12, quality: 0.5, updatedAt: "2026-01-01T00:00:00.000Z" } })).toEqual([]);
  });

  test("rejects entries the runtime validator rejects", () => {
    const withoutCategory = validEntry();
    delete withoutCategory.category;
    expect(validate(schema, withoutCategory)).toContain('$: missing required property "category"');
    expect(validate(schema, { ...validEntry(), category: { id: "Not Kebab", label: "x" } })).not.toEqual([]);
    expect(validate(schema, { ...validEntry(), category: { id: "collaboration", label: " " } })).not.toEqual([]);
    expect(validate(schema, { ...validEntry(), packageName: "Not/Valid Name" })).not.toEqual([]);
    expect(validate(schema, { ...validEntry(), profile: { name: "@pi-harness/plugin-agent-teams", config: [] } })).not.toEqual([]);
    expect(validate(schema, { ...groupEntry(), profile: { name: "@deepseek-ai/cordis-plugin-group", group: true, config: {} } })).not.toEqual([]);
    expect(validate(schema, { ...validEntry(), capabilities: [] })).not.toEqual([]);
    expect(validate(schema, { ...validEntry(), repository: "http://example.com" })).not.toEqual([]);
    expect(validate(schema, { ...validEntry(), unexpected: true })).not.toEqual([]);
  });
});
