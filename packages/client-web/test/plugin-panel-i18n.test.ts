import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// A plugin authors its panel title and description; the console renders them through t(). Those calls take a
// variable, so the source extractor behind "covers every message the source asks t() for" cannot see them, and a
// plugin string that never reached a catalog renders as Chinese in every other locale without failing a test.
// This reads the strings out of the plugins instead.
//
// A plugin still developed here is read from its TypeScript source, not from the published build installed beside
// it: the two drift between releases, and reading only the build would let a pull request change panel copy in
// packages/plugins without this guard noticing until after the change had already shipped. Plugins that were
// migrated to their own repository have no source here, so for those the installed build is the only evidence
// available — and it is also exactly what the console will load.

const localesDirectory = fileURLToPath(new URL("../src/locales/", import.meta.url));
const entriesDirectory = fileURLToPath(new URL("../../api-gateway/src/marketplace-entries/official/", import.meta.url));
const modulesDirectory = fileURLToPath(new URL("../../../node_modules/", import.meta.url));
const pluginSourceDirectory = fileURLToPath(new URL("../../plugins/", import.meta.url));

const CJK = /[一-鿿]/u;
// zh-TW shares the source script, so a string with no regional variant is legitimately identical there.
const SAME_SCRIPT_AS_SOURCE = new Set(["zh-TW"]);

const catalogNames = readdirSync(localesDirectory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""))
  .sort();

const readCatalog = (id: string): Record<string, string> => JSON.parse(readFileSync(`${localesDirectory}${id}.json`, "utf8")) as Record<string, string>;

interface PanelStrings {
  readonly id: string;
  readonly packageName: string;
  readonly origin: string;
  readonly strings: readonly string[];
  readonly registrations: number;
}

// Both the TypeScript source and the compiled entry keep the panel registration as plain object literals, so the
// title and description are read from the keys that follow the register call rather than by activating 75 plugins
// inside a unit test. The registration count is returned alongside so a silent under-match fails loudly instead of
// looking like a plugin with no panel.
function panelStrings(source: string): { strings: string[]; registrations: number } {
  const strings: string[] = [];
  const literal = /(?:title|description):\s*"((?:[^"\\]|\\.)*)"/gu;
  let registrations = 0;
  for (const registration of source.matchAll(/piPluginUi\.register\(\{/gu)) {
    registrations += 1;
    const start = registration.index + registration[0].length;
    const end = source.indexOf("read:", start);
    if (end < 0) continue;
    literal.lastIndex = 0;
    for (const match of source.slice(start, end).matchAll(literal)) strings.push(JSON.parse(`"${match[1] ?? ""}"`) as string);
  }
  return { strings, registrations };
}

// The source of truth for a plugin still developed in this repository is its source; for a migrated one it is the
// installed build. Resolving in that order is what makes this guard fail on the pull request that introduces bad
// copy rather than on the one that happens to bump a dependency afterwards.
function pluginEntryFile(packageName: string): string | undefined {
  const source = `${pluginSourceDirectory}${packageName.slice("@pi-harness/plugin-".length)}/src/index.ts`;
  if (existsSync(source)) return source;
  const installed = `${modulesDirectory}${packageName}/dist/index.js`;
  return existsSync(installed) ? installed : undefined;
}

const plugins: PanelStrings[] = readdirSync(entriesDirectory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(`${entriesDirectory}${name}`, "utf8")) as { id: string; packageName: string })
  .filter((entry) => entry.packageName.startsWith("@pi-harness/plugin-"))
  .map((entry) => {
    const entryFile = pluginEntryFile(entry.packageName);
    const extracted = entryFile === undefined ? { strings: [], registrations: 0 } : panelStrings(readFileSync(entryFile, "utf8"));
    return {
      id: entry.id,
      packageName: entry.packageName,
      origin: entryFile ?? "",
      strings: extracted.strings,
      registrations: extracted.registrations,
    };
  });

describe("plugin panel copy reaches every catalog", () => {
  test("reads panel strings out of every catalogued plugin", () => {
    const unresolved = plugins.filter((plugin) => plugin.origin === "").map((plugin) => plugin.id);
    expect(unresolved, "run npm ci: a migrated plugin is only readable from its installed build").toEqual([]);
    const withoutPanel = plugins.filter((plugin) => plugin.strings.length === 0).map((plugin) => plugin.id);
    expect(withoutPanel, "every catalogued plugin registers a panel, so extraction returning nothing means the shape changed").toEqual([]);
    // A registration whose literals the pattern could not reach would otherwise look identical to a plugin that
    // simply has fewer panels, and the missing copy would never be checked against a catalog.
    const underMatched = plugins
      .filter((plugin) => plugin.strings.length < plugin.registrations * 2)
      .map((plugin) => `${plugin.id} (${plugin.strings.length} of ${plugin.registrations * 2})`);
    expect(underMatched, "each panel registration must yield both a title and a description literal").toEqual([]);
  });

  test("prefers this repository's plugin source over the build installed beside it", () => {
    const local = plugins.filter((plugin) => plugin.origin.includes("/packages/plugins/"));
    // If this ever reaches zero, every plugin has migrated and the guard has quietly become build-only again.
    expect(local.length).toBeGreaterThan(0);
    expect(local.every((plugin) => plugin.origin.endsWith("/src/index.ts"))).toBe(true);
  });

  test("translates every source-language panel string in every catalog", () => {
    const sourceStrings = [...new Set(plugins.flatMap((plugin) => plugin.strings))].filter((text) => CJK.test(text)).sort();
    expect(sourceStrings.length).toBeGreaterThan(0);
    for (const name of catalogNames) {
      const catalog = readCatalog(name);
      const untranslated = sourceStrings.filter((text) => {
        const translation = catalog[text];
        if (typeof translation !== "string" || translation.trim() === "") return true;
        return !SAME_SCRIPT_AS_SOURCE.has(name) && translation === text;
      });
      expect([name, untranslated]).toEqual([name, []]);
    }
  });
});
