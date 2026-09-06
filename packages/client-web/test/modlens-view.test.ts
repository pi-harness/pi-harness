import { describe, expect, test } from "vitest";
import { modlensPanelView } from "../src/modlens-view.js";

describe("ModLens panel view", () => {
  test("normalizes completed evidence metadata and fixed safety limits without carrying evidence", () => {
    const view = modlensPanelView({
      attached: true,
      image: {
        mode: "evidence",
        path: "screens/diagram.png",
        mimeType: "image/png",
        bytes: 24,
        cached: true,
        at: "2026-09-05T19:00:00.000Z",
      },
      status: {
        state: "completed",
        mode: "evidence",
        path: "screens/diagram.png",
        mimeType: "image/png",
        bytes: 24,
        cached: true,
        at: "2026-09-05T19:00:00.000Z",
      },
      supportedTypes: ["gif", "jpeg", "jpg", "png", "webp"],
      limits: {
        imageBytes: 10_485_760,
        pathCharacters: 4_096,
        promptCharacters: 4_000,
        evidenceBytes: 524_288,
        agentTextBytes: 131_072,
        timeoutMs: 90_000,
        cacheEntries: 64,
      },
    });

    expect(view).toEqual({
      attached: true,
      image: {
        mode: "evidence",
        path: "screens/diagram.png",
        mimeType: "image/png",
        bytes: 24,
        cached: true,
        at: "2026-09-05T19:00:00.000Z",
      },
      status: {
        state: "completed",
        mode: "evidence",
        path: "screens/diagram.png",
        mimeType: "image/png",
        bytes: 24,
        cached: true,
        at: "2026-09-05T19:00:00.000Z",
      },
      supportedTypes: ["png", "jpeg", "jpg", "gif", "webp"],
      limits: {
        imageBytes: 10_485_760,
        pathCharacters: 4_096,
        promptCharacters: 4_000,
        evidenceBytes: 524_288,
        agentTextBytes: 131_072,
        timeoutMs: 90_000,
        cacheEntries: 64,
      },
      truncated: false,
    });
    expect(view.image).not.toHaveProperty("evidence");
    expect(view.status).not.toHaveProperty("evidence");
  });

  test("marks contradictory completed image metadata as truncated", () => {
    const view = modlensPanelView({
      attached: true,
      image: {
        mode: "evidence",
        path: "screens/original.png",
        mimeType: "image/png",
        bytes: 24,
        cached: false,
        at: "2026-09-05T19:00:00.000Z",
      },
      status: {
        state: "completed",
        mode: "native",
        path: "screens/replacement.jpg",
        mimeType: "image/jpeg",
        bytes: 25,
        cached: false,
        at: "2026-09-05T19:00:01.000Z",
      },
      supportedTypes: ["png", "jpeg", "jpg", "gif", "webp"],
      limits: {
        imageBytes: 10_485_760,
        pathCharacters: 4_096,
        promptCharacters: 4_000,
        evidenceBytes: 524_288,
        agentTextBytes: 131_072,
        timeoutMs: 180_000,
        cacheEntries: 64,
      },
    });

    expect(view.image).toMatchObject({ mode: "evidence", path: "screens/original.png", mimeType: "image/png", bytes: 24 });
    expect(view.status).toMatchObject({ state: "completed", mode: "native", path: "screens/replacement.jpg", mimeType: "image/jpeg", bytes: 25 });
    expect(view.truncated).toBe(true);
  });

  test("bounds hostile payloads, derives attachment state, and never invokes accessors", () => {
    let getterCalls = 0;
    const hostileImage = Object.defineProperty({}, "path", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "stolen.png";
      },
    });
    const view = modlensPanelView({
      attached: true,
      image: hostileImage,
      evidence: { summary: "browser-secret" },
      status: {
        state: "failed",
        mode: "native",
        path: `bad\n${"p".repeat(5_000)}`,
        at: "2026-09-05T19:00:00.000Z",
        error: `provider\u202e\n${"x".repeat(3_000)}`,
      },
      supportedTypes: Array.from({ length: 10_000 }, () => "svg"),
      limits: {
        imageBytes: Number.MAX_SAFE_INTEGER,
        pathCharacters: Number.POSITIVE_INFINITY,
        promptCharacters: -1,
        evidenceBytes: 1,
        agentTextBytes: 1,
        timeoutMs: Number.NaN,
        cacheEntries: 100_000,
      },
    });

    expect(getterCalls).toBe(0);
    expect(view.attached).toBe(false);
    expect(view.image).toBeNull();
    expect(view.status.state).toBe("failed");
    if (view.status.state !== "failed") throw new Error("expected failed status");
    expect(view.status.path.length).toBeLessThanOrEqual(4_096);
    expect(view.status.path).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(view.status.error.length).toBeLessThanOrEqual(2_000);
    expect(view.status.error).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(view.supportedTypes).toEqual(["png", "jpeg", "jpg", "gif", "webp"]);
    expect(view.limits).toEqual({
      imageBytes: 10_485_760,
      pathCharacters: 4_096,
      promptCharacters: 4_000,
      evidenceBytes: 524_288,
      agentTextBytes: 131_072,
      timeoutMs: 180_000,
      cacheEntries: 64,
    });
    expect(view.truncated).toBe(true);
    expect(JSON.stringify(view)).not.toContain("browser-secret");
  });

  test("fails closed when a supported-types container throws during inspection", () => {
    const poisonedTypes = new Proxy(["png"], {
      get() {
        throw new Error("must not escape the normalizer");
      },
    });

    expect(() =>
      modlensPanelView({
        attached: false,
        image: null,
        status: { state: "idle" },
        supportedTypes: poisonedTypes,
        limits: {
          imageBytes: 10_485_760,
          pathCharacters: 4_096,
          promptCharacters: 4_000,
          evidenceBytes: 524_288,
          agentTextBytes: 131_072,
          timeoutMs: 180_000,
          cacheEntries: 64,
        },
      }),
    ).not.toThrow();
    expect(modlensPanelView({ attached: false, image: null, status: { state: "idle" }, supportedTypes: poisonedTypes, limits: {} }).truncated).toBe(true);
  });

  test("fails closed when the entire payload is a revoked proxy", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(() => modlensPanelView(revocable.proxy)).not.toThrow();
    expect(modlensPanelView(revocable.proxy)).toMatchObject({ attached: false, image: null, status: { state: "idle" }, truncated: true });
  });
});
