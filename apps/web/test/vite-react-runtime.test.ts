import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("web React build configuration", () => {
  test("deduplicates React packages so hooks share the renderer dispatcher", async () => {
    const source = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(source).toMatch(/resolve:\s*\{[\s\S]*dedupe:\s*\[\s*"react"\s*,\s*"react-dom"\s*\]/u);
  });
});
