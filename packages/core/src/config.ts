import z from "@deepseek-ai/schemastery";

export const EmptyConfig = z.transform(z.any(), (value: unknown) => {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  let prototype: unknown;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    throw new Error("configuration could not be inspected safely", { cause: error });
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error("configuration must be a plain object");
  if (keys.length > 0) throw new Error(`unknown config keys: ${keys.map((key) => String(key)).join(", ")}`);
  return {};
});

export function assertKnownConfigKeys(plugin: string, config: unknown, known: readonly string[]): void {
  if (config === undefined || config === null || typeof config !== "object") return;
  const unknown = Object.keys(config).filter((key) => !known.includes(key));
  if (unknown.length > 0)
    throw new Error(`Unknown ${plugin} config keys: ${unknown.join(", ")}; supported keys are ${known.length === 0 ? "(none)" : known.join(", ")}`);
}
