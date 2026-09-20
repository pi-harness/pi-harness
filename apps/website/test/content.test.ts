import { describe, expect, test } from "vitest";
import { siteContent, SiteContentSchema } from "../src/content.js";

describe("website content", () => {
  test("ships a validated product story with the primary conversion paths", () => {
    const parsed = SiteContentSchema.parse(siteContent);

    expect(parsed.hero.primaryAction.href).toBe("#install");
    expect(parsed.hero.secondaryAction.href).toBe("#console");
    expect(parsed.features.length).toBeGreaterThanOrEqual(4);
    expect(parsed.workflow.length).toBe(4);
  });
});
