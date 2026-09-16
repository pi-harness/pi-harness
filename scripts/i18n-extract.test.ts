import { describe, expect, test } from "vitest";
// The extractor is a plain .mjs build script carrying JSDoc types rather than a typed module, so the import is given its shape here.
import * as extractor from "./i18n-extract.mjs";

const { extractTranslatableKeys, mergeCatalog } = extractor as unknown as {
  extractTranslatableKeys: () => { keys: readonly string[]; rewritten: readonly unknown[] };
  mergeCatalog: (existing: Record<string, string>, keys: readonly string[], options?: { prune?: boolean }) => Record<string, string>;
};
const merge = mergeCatalog;

describe("catalog merge", () => {
  // The console's catalogs also translate copy that the plugin packages publish, and the scan never reads those packages. A merge that kept only the keys it found deleted every one of those translations.
  test("keeps translated keys the scan cannot see", () => {
    const existing = { 面板数据异常: "Invalid panel data", 已连接: "Connected" };
    expect(merge(existing, ["已连接"])).toEqual(existing);
  });

  test("adds the keys the source asks for with an empty translation", () => {
    expect(merge({ 已连接: "Connected" }, ["已连接", "目录"])).toEqual({ 已连接: "Connected", 目录: "" });
  });

  test("drops keys that were never translated in the first place", () => {
    expect(merge({ 已连接: "Connected", 目录: "" }, ["已连接"])).toEqual({ 已连接: "Connected" });
  });

  test("prunes everything outside the scan only when asked", () => {
    expect(merge({ 面板数据异常: "Invalid panel data", 已连接: "Connected" }, ["已连接"], { prune: true })).toEqual({ 已连接: "Connected" });
  });

  test("sorts the result so a regeneration is a stable diff", () => {
    expect(Object.keys(merge({ b: "B", a: "A" }, ["c"]))).toEqual(["a", "b", "c"]);
  });
});

describe("key extraction", () => {
  // t(condition ? "甲 条" : "乙 条", vars) is already a translated message. Re-wrapping its branches produced t(t("甲 条"), vars), which looks an already-translated string up as a key.
  test("collects both branches of a conditional message without rewriting them", () => {
    const { keys, rewritten } = extractTranslatableKeys();
    expect(rewritten).toEqual([]);
    expect(keys).toContain("本页匹配 {v0} 个会话");
    expect(keys).toContain("{v0} 个会话");
  });

  test("leaves the checked-in sources alone, so the script is safe to re-run", () => {
    expect(extractTranslatableKeys().rewritten).toEqual([]);
  });
});
