import { existsSync } from "node:fs";
import { expect, test } from "vitest";

test("only aliases plugin packages whose local source still exists", async () => {
  const config = (await import("./vitest.config.ts")).default as { resolve?: { alias?: readonly unknown[] } };
  const aliases = config.resolve?.alias ?? [];
  const replacements = aliases.flatMap((alias) => {
    if (typeof alias !== "object" || alias === null || !("replacement" in alias)) return [];
    const replacement = (alias as { replacement?: unknown }).replacement;
    return typeof replacement === "string" ? [replacement] : [];
  });

  const pluginAliases = aliases.filter(
    (alias) =>
      typeof alias === "object" &&
      alias !== null &&
      "find" in alias &&
      (String((alias as { find?: unknown }).find).includes("plugin-") ||
        (typeof (alias as { find?: unknown }).find === "string" && (alias as { find?: string }).find?.startsWith("@pi-harness/plugin-"))),
  );
  expect(pluginAliases.length).toBeGreaterThan(0);
  expect(
    pluginAliases.every((alias) => {
      if (typeof alias !== "object" || alias === null || !("find" in alias) || !("replacement" in alias)) return false;
      const find = (alias as { find?: unknown }).find;
      const replacement = (alias as { replacement?: unknown }).replacement;
      return typeof find === "string" && find.startsWith("@pi-harness/plugin-") && typeof replacement === "string" && existsSync(replacement);
    }),
  ).toBe(true);
  expect(replacements.every((replacement) => !replacement.includes("/packages/plugins/") || existsSync(replacement))).toBe(true);
});
