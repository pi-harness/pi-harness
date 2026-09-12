import { describe, expect, test } from "vitest";
import { promptLibraryPanelView } from "../src/prompt-library-view.js";

const template = {
  id: "prompt-1",
  title: "Tenant refund review",
  prompt: "Verify the order and refund evidence.",
  tags: ["tenant-a", "refund"],
  createdAt: "2026-09-12T03:00:00.000Z",
  updatedAt: "2026-09-12T03:00:01.000Z",
};
const report = { total: 1, shown: 1, truncated: false, templates: [template] };

describe("Prompt Library panel view", () => {
  test("returns a detached validated view", () => {
    const view = promptLibraryPanelView(report);
    expect(view).toEqual({ ...report, malformed: false });
    expect(view.templates).not.toBe(report.templates);
    expect(view.templates[0]).not.toBe(template);
    expect(view.templates[0]?.tags).not.toBe(template.tags);
  });

  test("accepts NUL text emitted by the backend contract", () => {
    expect(promptLibraryPanelView({ ...report, templates: [{ ...template, prompt: "Preserve\0the exact payload" }] })).toMatchObject({
      malformed: false,
      templates: [{ prompt: "Preserve\0the exact payload" }],
    });
  });

  test("fails closed for contradictory inventory and malformed templates", () => {
    const malformed = [
      null,
      { ...report, total: 2 },
      { ...report, shown: 0 },
      { ...report, truncated: true },
      { ...report, templates: [{ ...template, updatedAt: "2026-09-12T02:59:59.000Z" }] },
      { ...report, templates: [{ ...template, tags: ["refund", "refund"] }] },
      { total: 2, shown: 2, truncated: false, templates: [template, template] },
    ];
    for (const value of malformed) expect(promptLibraryPanelView(value)).toMatchObject({ malformed: true, total: 0, templates: [] });
  });

  test("does not invoke accessors or revoked proxies", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "total", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [accessor, revoked.proxy]) expect(promptLibraryPanelView(value)).toMatchObject({ malformed: true });
    expect(getterCalls).toBe(0);
  });

  test("rejects templates that are not newest first while allowing equal legacy timestamps", () => {
    const older = { ...template, id: "prompt-older", updatedAt: "2026-09-12T03:00:01.000Z" };
    const newer = { ...template, id: "prompt-newer", updatedAt: "2026-09-12T03:00:02.000Z" };
    expect(promptLibraryPanelView({ total: 2, shown: 2, truncated: false, templates: [older, newer] })).toMatchObject({ malformed: true });
    expect(
      promptLibraryPanelView({
        total: 2,
        shown: 2,
        truncated: false,
        templates: [template, { ...template, id: "prompt-equal" }],
      }),
    ).toMatchObject({ malformed: false });
  });
});
