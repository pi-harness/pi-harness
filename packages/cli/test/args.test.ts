import { describe, expect, test } from "vitest";
import { parseLauncherArgs } from "../src/args.js";

describe("parseLauncherArgs", () => {
  test("uses the default profile and forwards application arguments", () => {
    expect(parseLauncherArgs(["--prompt", "hello"])).toEqual({ mode: "run", profile: "default", dumpConfig: false, args: ["--prompt", "hello"] });
  });

  test("forwards the end-of-options separator so the application can take option-shaped prompts literally", () => {
    expect(parseLauncherArgs(["--profile", "development", "--", "--profile", "inside", "hello"])).toEqual({ mode: "run", profile: "development", dumpConfig: false, args: ["--", "--profile", "inside", "hello"] });
  });

  test("stops recognizing launcher options at the first application argument", () => {
    expect(parseLauncherArgs(["--prompt", "--version"])).toEqual({ mode: "run", profile: "default", dumpConfig: false, args: ["--prompt", "--version"] });
    expect(parseLauncherArgs(["explain", "what", "tar", "-h", "prints"])).toEqual({ mode: "run", profile: "default", dumpConfig: false, args: ["explain", "what", "tar", "-h", "prints"] });
    expect(parseLauncherArgs(["hello", "--profile", "development"])).toEqual({ mode: "run", profile: "default", dumpConfig: false, args: ["hello", "--profile", "development"] });
  });

  test("accepts the inline form of launcher options", () => {
    expect(parseLauncherArgs(["--profile=development", "hello"])).toEqual({ mode: "run", profile: "development", dumpConfig: false, args: ["hello"] });
    expect(parseLauncherArgs(["--config=./custom.yml", "--dump-config"])).toEqual({ mode: "run", configPath: "./custom.yml", dumpConfig: true, args: [] });
    expect(() => parseLauncherArgs(["--profile="])).toThrow(/--profile requires a value/);
    expect(() => parseLauncherArgs(["--config="])).toThrow(/--config requires a value/);
    expect(() => parseLauncherArgs(["--profile=a", "--profile=b"])).toThrow(/may only be specified once/);
  });

  test("accepts an explicit config instead of a profile", () => {
    expect(parseLauncherArgs(["--config", "./custom.yml", "--dump-config"])).toEqual({ mode: "run", configPath: "./custom.yml", dumpConfig: true, args: [] });
  });

  test.each([
    ["--help", "help"],
    ["-h", "help"],
    ["--version", "version"],
    ["-v", "version"],
  ] as const)("maps %s to %s mode", (flag, mode) => {
    expect(parseLauncherArgs([flag])).toEqual({ mode });
  });

  test("rejects mutually exclusive profile and config options", () => {
    expect(() => parseLauncherArgs(["--profile", "default", "--config", "custom.yml"])).toThrow(/cannot be used together/);
  });

  test("rejects a launcher option with no value", () => {
    expect(() => parseLauncherArgs(["--profile"])).toThrow(/--profile requires a value/);
  });
});
