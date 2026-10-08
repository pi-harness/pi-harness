import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  LOCALES,
  SOURCE_LOCALE,
  activeLocale,
  formatLocale,
  isSupportedLocale,
  loadCatalog,
  readStoredLocale,
  resolveLocale,
  setLocale,
  t,
} from "../src/i18n.js";

const localesDirectory = fileURLToPath(new URL("../src/locales/", import.meta.url));

const catalogFiles = readdirSync(localesDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();

const readCatalog = (id: string): Record<string, string> => JSON.parse(readFileSync(`${localesDirectory}${id}.json`, "utf8")) as Record<string, string>;

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1] ?? "").sort();

describe("locale resolution", () => {
  test("prefers an exact match over the language that only shares a primary subtag", () => {
    expect(resolveLocale(["pt-BR", "pt"])).toBe("pt-BR");
    expect(resolveLocale(["zh-TW"])).toBe("zh-TW");
  });

  test("falls back to the primary subtag and then to the source locale", () => {
    expect(resolveLocale(["fr-CA"])).toBe("fr");
    expect(resolveLocale(["en-GB", "de"])).toBe("en");
    expect(resolveLocale(["is", "mt"])).toBe(SOURCE_LOCALE);
    expect(resolveLocale([])).toBe(SOURCE_LOCALE);
  });

  test("ignores a stored preference that names a locale this build does not ship", () => {
    expect(readStoredLocale({ getItem: () => "ja" })).toBe("ja");
    expect(readStoredLocale({ getItem: () => "kl" })).toBeUndefined();
    expect(
      readStoredLocale({
        getItem: () => {
          throw new Error("storage blocked");
        },
      }),
    ).toBeUndefined();
  });
});

describe("translation lookup", () => {
  test("renders the Chinese source when no catalog is active", () => {
    expect(activeLocale()).toBe(SOURCE_LOCALE);
    expect(t("已连接")).toBe("已连接");
  });

  test("substitutes named placeholders and leaves unknown ones visible", () => {
    expect(t("第 {v0} 页", { v0: 3 })).toBe("第 3 页");
    expect(t("缺失 {missing} 个，额外 {extra} 个。", { missing: 1 })).toBe("缺失 1 个，额外 {extra} 个。");
  });

  test("switches the catalog and the formatting locale together, and back", async () => {
    await setLocale("en");
    expect(activeLocale()).toBe("en");
    expect(formatLocale()).toBe("en");
    expect(t("已连接")).toBe("Connected");
    expect(t("第 {v0} 页", { v0: 3 })).toBe("Page 3");

    await setLocale("nope");
    expect(activeLocale()).toBe(SOURCE_LOCALE);
    expect(t("已连接")).toBe("已连接");
  });

  test("keeps the source text when a locale ships no catalog", async () => {
    expect(await loadCatalog(SOURCE_LOCALE)).toEqual({});
  });
});

describe("catalog integrity", () => {
  test("ships one catalog per supported locale, and nothing else", () => {
    const shipped = LOCALES.filter((locale) => locale.id !== SOURCE_LOCALE)
      .map((locale) => `${locale.id}.json`)
      .sort();
    expect(catalogFiles).toEqual(shipped);
    expect(LOCALES.every((locale) => isSupportedLocale(locale.id))).toBe(true);
  });

  test("every catalog carries the same keys as English", () => {
    const reference = Object.keys(readCatalog("en"));
    for (const name of catalogFiles) expect([name, Object.keys(readCatalog(name.replace(".json", "")))]).toEqual([name, reference]);
  });

  test("translates the custom workspace path controls in every catalog", () => {
    const keys = ["输入绝对路径，如 /tmp/my-project", "打开"];
    for (const name of catalogFiles) {
      const catalog = readCatalog(name.replace(".json", ""));
      for (const key of keys) {
        expect([name, key, catalog[key]]).toEqual([name, key, expect.stringMatching(/\S/u)]);
        expect([name, key, catalog[key]]).not.toEqual([name, key, key]);
      }
    }
  });

  // Catalogs that agree with each other can still all be missing the same string: the source is the only place that knows which messages the console can actually display.
  test("covers every message the source asks t() for", async () => {
    const { extractTranslatableKeys } = (await import("../../../scripts/i18n-extract.mjs")) as {
      extractTranslatableKeys: () => { keys: readonly string[] };
    };
    const shipped = new Set(Object.keys(readCatalog("en")));
    const missing = extractTranslatableKeys().keys.filter((key) => !shipped.has(key));
    expect(missing).toEqual([]);
  });

  test("no entry is left empty", () => {
    for (const name of catalogFiles) {
      const empty = Object.entries(readCatalog(name.replace(".json", "")))
        .filter(([, value]) => value.trim() === "")
        .map(([key]) => key);
      expect([name, empty]).toEqual([name, []]);
    }
  });

  test("every translation keeps the placeholders its key declares", () => {
    for (const name of catalogFiles) {
      const mismatched = Object.entries(readCatalog(name.replace(".json", "")))
        .filter(([key, value]) => placeholders(key).join(",") !== placeholders(value).join(","))
        .map(([key]) => key);
      expect([name, mismatched]).toEqual([name, []]);
    }
  });

  // The catalogs carry no plural rules: a count of one has its own key, and every other count shares the plural form. A count string that ships without its singular sibling renders "1 sessions" in every language that inflects, so the ones that have a sibling in English must have one everywhere, and the number without one is a ratchet like the reference documentation's: it may only ever go down. Lower the budget whenever it drops.
  test("every count message that has a singular form has it in every catalog, and no new one ships without", () => {
    const pluralOnlyBudget = 23;
    const reference = readCatalog("en");
    const singularOf = (key: string): string => key.replace(/\{(?:count|v0)\}/u, "1");
    const countKeys = Object.keys(reference).filter((key) => /^(?:本页匹配 )?\{(?:count|v0)\} [个条]/u.test(key));
    const withSingular = countKeys.filter((key) => singularOf(key) in reference);
    expect(withSingular).toEqual(
      expect.arrayContaining([
        "{count} 条日志消息",
        "{count} 条上下文消息",
        "{v0} 个会话",
        "本页匹配 {v0} 个会话",
        "{count} 个变更",
        "{v0} 个插件",
        "{count} 条消息",
      ]),
    );
    const pluralOnly = countKeys.filter((key) => !(singularOf(key) in reference));
    expect(pluralOnly.length, `count messages without a singular form: ${pluralOnly.join(", ")}`).toBeLessThanOrEqual(pluralOnlyBudget);
    for (const name of catalogFiles) {
      const catalog = readCatalog(name.replace(".json", ""));
      const missing = withSingular.map(singularOf).filter((singular) => typeof catalog[singular] !== "string" || catalog[singular].trim() === "");
      expect([name, missing]).toEqual([name, []]);
    }
  });

  // French calls a plugin "extension", which is feminine, so the states that qualify one carry their own keys and are inflected here; the shared adjectives stay masculine for the dependency heading and the notifier that still use them.
  test("inflects the plugin state adjectives for the feminine noun French uses", () => {
    const fr = readCatalog("fr");
    expect(fr["插件"]).toBe("Extensions");
    for (const key of ["已安装的插件", "插件已安装", "插件已停用", "插件已验证", "实验性插件", "插件已加载", "插件未加载"])
      expect([key, fr[key]]).toEqual([key, expect.stringMatching(/ées?$|ale$/u)]);
    expect(fr["已安装"]).toBe("Installé");
  });

  test("every translation keeps the leading and trailing spacing its key declares", () => {
    for (const name of catalogFiles) {
      const mismatched = Object.entries(readCatalog(name.replace(".json", "")))
        .filter(([key, value]) => key.startsWith(" ") !== value.startsWith(" ") || key.endsWith(" ") !== value.endsWith(" "))
        .map(([key]) => key);
      expect([name, mismatched]).toEqual([name, []]);
    }
  });
});
