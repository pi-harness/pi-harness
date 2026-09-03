import { describe, expect, test } from "vitest";
import { isPluginRepositoryName } from "../src/plugins/plugin-check.js";

describe("plugin repository discovery", () => {
  test("accepts Pi Harness and legacy DSH plugin directory names", () => {
    expect(isPluginRepositoryName("pi-colleague-skill")).toBe(true);
    expect(isPluginRepositoryName("dsh-vision-toolkit")).toBe(true);
    expect(isPluginRepositoryName("example-plugin")).toBe(true);
  });

  test("does not scan dependency or hidden directories", () => {
    expect(isPluginRepositoryName("node_modules")).toBe(false);
    expect(isPluginRepositoryName(".git")).toBe(false);
    expect(isPluginRepositoryName("workspace")).toBe(false);
  });
});
