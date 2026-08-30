import { describe, expect, test } from "vitest";
import { shouldRelaunchForDevelopmentProfile } from "../src/relaunch.js";

describe("development profile relaunch", () => {
  test("requests Node internals only for an executable built-in development profile", () => {
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "development"], [])).toBe(true);
    expect(shouldRelaunchForDevelopmentProfile(["--profile=development", "hello"], [])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "default"], [])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--config", "cordis.yml"], [])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "development", "--dump-config"], [])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "development"], ["--expose-internals"])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--profile"], [])).toBe(false);
  });
});
