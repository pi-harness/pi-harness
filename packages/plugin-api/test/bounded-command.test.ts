import { expect, test } from "vitest";
import { runBoundedCommand } from "../src/bounded-command.js";

test.each([0, 7])("preserves raw output bytes with buffer encoding on exit %s", async (code) => {
  const bytes = Buffer.from([0, 255, 128, 10]);
  const operation = runBoundedCommand(
    [process.execPath, "-e", `process.stdout.write(Buffer.from([0,255,128,10]));process.stderr.write(Buffer.from([0,255,128,10]));process.exitCode=${code}`],
    process.cwd(), 2000, 1024, undefined, { encoding: "buffer" },
  );
  if (code === 0) expect(await operation).toEqual({ stdout: bytes, stderr: bytes });
  else await expect(operation).rejects.toMatchObject({ code, stdout: bytes, stderr: bytes });
});

test("passes explicit child environment without mutating the host", async () => {
  const before = process.env.PI_HARNESS_RUNNER_FIXTURE;
  const result = await runBoundedCommand(
    [process.execPath, "-e", 'process.stdout.write(process.env.PI_HARNESS_RUNNER_FIXTURE ?? "missing")'],
    process.cwd(), 2000, 1024, undefined,
    { env: { ...process.env, PI_HARNESS_RUNNER_FIXTURE: "literal-data;not-code" } },
  );
  expect(result.stdout).toBe("literal-data;not-code");
  expect(process.env.PI_HARNESS_RUNNER_FIXTURE).toBe(before);
});

test.each([0, -1, NaN, Infinity, 2 ** 31])("rejects invalid command timeout %s before execution", async (timeout) => {
  await expect(async () => runBoundedCommand([process.execPath, "-e", ""], process.cwd(), timeout, 100)).rejects.toThrow("Command timeout must");
});

test.each([-1, NaN, Infinity, 1.5])("rejects invalid command output bound %s before execution", async (limit) => {
  await expect(async () => runBoundedCommand([process.execPath, "-e", ""], process.cwd(), 10000, limit)).rejects.toThrow("Command output limit must");
});
