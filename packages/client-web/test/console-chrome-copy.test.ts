import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const source = async (): Promise<string> => readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
const styles = async (): Promise<string> => readFile(new URL("../../../apps/web/src/style.css", import.meta.url), "utf8");
const catalog = async (id: string): Promise<Record<string, string>> =>
  JSON.parse(await readFile(new URL(`../src/locales/${id}.json`, import.meta.url), "utf8")) as Record<string, string>;
const locales = ["de", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-TW"] as const;

describe("console chrome copy and layout", () => {
  test("labels the Mermaid off option with the state word rather than the dialog dismiss verb", async () => {
    const text = await source();
    // The dismiss key is the aria-label of every dialog close button, which is why each catalog translated it as an imperative.
    expect(text).toContain('<option value="off">{t("已关闭")}</option>');
    expect(text).not.toContain('<option value="off">{t("关闭")}</option>');
    const english = await catalog("en");
    expect([english["已关闭"], english["关闭"]]).toEqual(["Off", "Close"]);
  });

  test("names the real restore path in the archive confirmation, in every catalog", async () => {
    const key = "归档后会从默认列表隐藏；在会话工具中打开「显示归档会话」，再对该会话选择「恢复会话」。";
    const text = await source();
    expect(text).toContain(`t("${key}")`);
    expect(text).not.toContain("归档后会从默认列表隐藏，之后仍可在会话工具中恢复。");
    for (const id of locales) {
      const entries = await catalog(id);
      // Restore lives on the archived session's own row, which only appears once Show archived sessions is turned on, so the copy has to name both steps in that catalog's own wording.
      const reveal = entries["显示归档会话"];
      const restore = entries["恢复会话"];
      expect([id, reveal, restore]).toEqual([id, expect.stringMatching(/\S/u), expect.stringMatching(/\S/u)]);
      expect([id, entries[key]?.includes(reveal), entries[key]?.includes(restore)]).toEqual([id, true, true]);
    }
  });

  test("stops offering Stop once the runtime is unreachable", async () => {
    expect(await source()).toContain('<button className="stop-button" disabled={runTelemetry.tone === "offline"}');
  });

  test("keeps the touch-sized session row menu unpainted on the tablet break", async () => {
    const text = await styles();
    const tabletBreak = text.slice(text.indexOf("@media (min-width: 681px) and (max-width: 900px)"));
    const rule = tabletBreak.slice(tabletBreak.indexOf(".session-row-more"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("[background:transparent]");
  });
});
