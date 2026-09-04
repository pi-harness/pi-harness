export function assertKnownConfigKeys(plugin: string, config: unknown, known: readonly string[]): void {
  if (config === undefined || config === null || typeof config !== "object") return;
  const unknown = Object.keys(config).filter((key) => !known.includes(key));
  if (unknown.length > 0)
    throw new Error(`Unknown ${plugin} config keys: ${unknown.join(", ")}; supported keys are ${known.length === 0 ? "(none)" : known.join(", ")}`);
}
