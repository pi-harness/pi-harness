import { describe, expect, it } from "vitest";
import { openPetsPanelView } from "../src/openpets-view.js";

describe("OpenPets view", () => {
  it("normalizes a complete companion panel payload", () => {
    expect(
      openPetsPanelView({
        name: "Mochi",
        mood: "happy",
        energy: 92,
        interactions: 12,
        lastEvent: "play",
        updatedAt: "2026-09-05T10:00:00.000Z",
        recovery: { sessionEntries: 40, scanned: 40, truncated: false, restored: true },
        persistence: { attempts: 3, failures: 1, lastError: "disk full" },
        limits: { nameCharacters: 128, recoveryEntries: 10_000, persistenceErrorCharacters: 2_000 },
      }),
    ).toEqual({
      name: "Mochi",
      mood: "happy",
      energy: 92,
      interactions: 12,
      lastEvent: "play",
      updatedAt: "2026-09-05T10:00:00.000Z",
      recovery: { sessionEntries: 40, scanned: 40, truncated: false, restored: true },
      persistence: { attempts: 3, failures: 1, lastError: "disk full" },
      limits: { nameCharacters: 128, recoveryEntries: 10_000, persistenceErrorCharacters: 2_000 },
    });
  });

  it("enforces fixed browser caps and repairs hostile state and inventory values", () => {
    const long = "x".repeat(20_000);
    expect(
      openPetsPanelView({
        name: long,
        mood: "sleepy",
        energy: Number.NaN,
        interactions: Number.POSITIVE_INFINITY,
        lastEvent: long,
        updatedAt: long,
        recovery: { sessionEntries: 20_000, scanned: 20_000, truncated: false, restored: "yes" },
        persistence: { attempts: 4, failures: 99, lastError: long },
        limits: { nameCharacters: 9_999, recoveryEntries: 99_999, persistenceErrorCharacters: 9_999 },
      }),
    ).toEqual({
      name: "x".repeat(128),
      mood: "idle",
      energy: 80,
      interactions: 0,
      lastEvent: "session_start",
      updatedAt: null,
      recovery: { sessionEntries: 20_000, scanned: 10_000, truncated: true, restored: false },
      persistence: { attempts: 4, failures: 4, lastError: "x".repeat(2_000) },
      limits: { nameCharacters: 128, recoveryEntries: 10_000, persistenceErrorCharacters: 2_000 },
    });
  });
});
