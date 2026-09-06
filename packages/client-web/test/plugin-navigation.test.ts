import { describe, expect, it } from "vitest";
import { installedPluginDetailPath, readInstalledPluginDetailId } from "../src/plugin-navigation.js";

describe("installed plugin navigation", () => {
  it("uses a stable secondary route for installed plugin details", () => {
    expect(installedPluginDetailPath("@pi-harness/core/plugins/docker-sandbox")).toBe("?page=plugins&plugin=%40pi-harness%2Fcore%2Fplugins%2Fdocker-sandbox");
  });

  it("only reads plugin details on the installed plugins page", () => {
    expect(readInstalledPluginDetailId(new URLSearchParams("page=plugins&plugin=docker-sandbox"))).toBe("docker-sandbox");
    expect(readInstalledPluginDetailId(new URLSearchParams("page=marketplace&plugin=docker-sandbox"))).toBeUndefined();
    expect(readInstalledPluginDetailId(new URLSearchParams("page=plugins&plugin=%20%20"))).toBeUndefined();
  });
});
