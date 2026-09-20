import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// A plugin authors its panel title and description; the console renders them through t(). Those calls take a
// variable, so the source extractor behind "covers every message the source asks t() for" cannot see them, and a
// plugin string that never reached a catalog renders as Chinese in every other locale without failing a test.
// This reads the strings out of the shipped plugin packages instead, which is where they actually come from.

const localesDirectory = fileURLToPath(new URL("../src/locales/", import.meta.url));
const entriesDirectory = fileURLToPath(new URL("../../api-gateway/src/marketplace-entries/official/", import.meta.url));
const modulesDirectory = fileURLToPath(new URL("../../../node_modules/", import.meta.url));

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
  readonly strings: readonly string[];
}

// The compiled plugin entry keeps the panel registration as plain object literals, so the title and description are
// read from the two keys that follow the register call rather than by activating 75 plugins inside a unit test.
function panelStrings(source: string): string[] {
  const found: string[] = [];
  const literal = /(?:title|description):\s*"((?:[^"\\]|\\.)*)"/gu;
  for (const registration of source.matchAll(/piPluginUi\.register\(\{/gu)) {
    const start = registration.index + registration[0].length;
    const end = source.indexOf("read:", start);
    if (end < 0) continue;
    literal.lastIndex = 0;
    for (const match of source.slice(start, end).matchAll(literal)) found.push(JSON.parse(`"${match[1] ?? ""}"`) as string);
  }
  return found;
}

const plugins: PanelStrings[] = readdirSync(entriesDirectory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(`${entriesDirectory}${name}`, "utf8")) as { id: string; packageName: string })
  .filter((entry) => entry.packageName.startsWith("@pi-harness/plugin-"))
  .map((entry) => {
    const entryFile = `${modulesDirectory}${entry.packageName}/dist/index.js`;
    return {
      id: entry.id,
      packageName: entry.packageName,
      strings: existsSync(entryFile) ? panelStrings(readFileSync(entryFile, "utf8")) : [],
    };
  });

describe("plugin panel copy reaches every catalog", () => {
  test("reads panel strings out of every catalogued plugin package", () => {
    const withoutPackage = plugins.filter((plugin) => !existsSync(`${modulesDirectory}${plugin.packageName}/dist/index.js`)).map((plugin) => plugin.id);
    expect(withoutPackage, "run npm ci: the catalogued plugin packages are the source of these strings").toEqual([]);
    const withoutPanel = plugins.filter((plugin) => plugin.strings.length === 0).map((plugin) => plugin.id);
    expect(withoutPanel, "every catalogued plugin registers a panel, so extraction returning nothing means the shape changed").toEqual([]);
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
