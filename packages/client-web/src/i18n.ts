import { useSyncExternalStore } from "react";

/**
 * The console was written in Chinese, so the Chinese text is the message key: `t("已连接")` looks "已连接" up in the active catalog and falls back to the key itself.
 * A missing translation therefore renders exactly what this console rendered before it had any translations at all, and zh-CN needs no catalog file.
 */

export interface LocaleDescriptor {
  readonly id: string;
  /** The language's own name, because a language picker that reads "Japanese" is useless to someone who cannot read English. */
  readonly label: string;
}

export const LOCALES: readonly LocaleDescriptor[] = [
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁體中文" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "pt-BR", label: "Português (Brasil)" },
  { id: "ru", label: "Русский" },
];

export const SOURCE_LOCALE = "zh-CN";
export const LOCALE_STORAGE_KEY = "pi-harness.locale";

export type Catalog = Readonly<Record<string, string>>;

// Static loaders rather than a computed import path, because a bundler cannot split what it cannot see, and only the active locale should ever be fetched.
const LOADERS: Readonly<Record<string, () => Promise<{ readonly default: Catalog }>>> = {
  "zh-TW": () => import("./locales/zh-TW.json", { with: { type: "json" } }),
  en: () => import("./locales/en.json", { with: { type: "json" } }),
  ja: () => import("./locales/ja.json", { with: { type: "json" } }),
  ko: () => import("./locales/ko.json", { with: { type: "json" } }),
  es: () => import("./locales/es.json", { with: { type: "json" } }),
  fr: () => import("./locales/fr.json", { with: { type: "json" } }),
  de: () => import("./locales/de.json", { with: { type: "json" } }),
  "pt-BR": () => import("./locales/pt-BR.json", { with: { type: "json" } }),
  ru: () => import("./locales/ru.json", { with: { type: "json" } }),
};

export function isSupportedLocale(id: string): boolean {
  return LOCALES.some((locale) => locale.id === id);
}

/** The first supported locale among the browser's preferences, matching "pt-BR" before falling back to the "pt" that shares its primary subtag. */
export function resolveLocale(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    const exact = LOCALES.find((locale) => locale.id.toLowerCase() === candidate.toLowerCase());
    if (exact) return exact.id;
    const primary = candidate.split("-")[0]?.toLowerCase();
    if (primary === undefined) continue;
    const partial = LOCALES.find((locale) => locale.id.split("-")[0]?.toLowerCase() === primary);
    if (partial) return partial.id;
  }
  return SOURCE_LOCALE;
}

export function readStoredLocale(storage: Pick<Storage, "getItem"> | undefined): string | undefined {
  try {
    const stored = storage?.getItem(LOCALE_STORAGE_KEY);
    return typeof stored === "string" && isSupportedLocale(stored) ? stored : undefined;
  } catch {
    // Reading localStorage throws outright when the browser blocks storage for the origin, and a blocked preference is the same as an unset one.
    return undefined;
  }
}

export function writeStoredLocale(storage: Pick<Storage, "setItem"> | undefined, locale: string): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // A rejected write only costs the preference on the next load; it must not take the language switch down with it.
  }
}

export async function loadCatalog(locale: string): Promise<Catalog> {
  const loader = LOADERS[locale];
  if (!loader) return {};
  try {
    return (await loader()).default;
  } catch {
    // A catalog that fails to load leaves every string on its Chinese source, which is worse than the translation but better than a blank console.
    return {};
  }
}

let activeLocaleId = SOURCE_LOCALE;
let activeCatalog: Catalog = {};
const listeners = new Set<() => void>();

export function activeLocale(): string {
  return activeLocaleId;
}

/** Loads the catalog and swaps it in as one step, so no render ever sees the new locale id against the old locale's strings. */
export async function setLocale(locale: string): Promise<void> {
  const next = isSupportedLocale(locale) ? locale : SOURCE_LOCALE;
  const catalog = await loadCatalog(next);
  activeLocaleId = next;
  activeCatalog = catalog;
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const PLACEHOLDER = /\{(\w+)\}/gu;

/** Translates `source` and substitutes `{name}` placeholders; an unknown placeholder is left verbatim so a bad catalog entry is visible rather than silently empty. */
export function t(source: string, values?: Readonly<Record<string, string | number>>): string {
  const translated = activeCatalog[source];
  // An empty entry means the catalog has the key but nobody filled it in, and rendering nothing at all is worse than rendering the Chinese source.
  const template = translated === undefined || translated === "" ? source : translated;
  if (values === undefined) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/** The locale to hand `Intl` and `toLocale*` so numbers, dates and sorting follow the language the console is displaying. */
export function formatLocale(): string {
  return activeLocaleId;
}

/** Re-renders the calling component when the language changes. The server snapshot is the source locale because that is what a render with no catalog produces. */
export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, activeLocale, () => SOURCE_LOCALE);
}
