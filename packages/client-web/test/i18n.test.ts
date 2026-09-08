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

  test("every translation keeps the leading and trailing spacing its key declares", () => {
    for (const name of catalogFiles) {
      const mismatched = Object.entries(readCatalog(name.replace(".json", "")))
        .filter(([key, value]) => key.startsWith(" ") !== value.startsWith(" ") || key.endsWith(" ") !== value.endsWith(" "))
        .map(([key]) => key);
      expect([name, mismatched]).toEqual([name, []]);
    }
  });
});
