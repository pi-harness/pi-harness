import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

const readText = async (path: string): Promise<string> => readFile(resolve(repositoryRoot, path), "utf8");

// The number of built-in plugins that `docs/README.reference.md` still has no `###` section for. It may only ever go down.
const undocumentedBudget = 53;

describe("reference documentation", () => {
  it("documents every registered API route", async () => {
    // The reference is the inventory a reader audits the unauthenticated local port with, so an undocumented route is an invisible attack surface.
    const gateway = await readText("packages/api-gateway/src/index.ts");
    const reference = await readText("docs/README.reference.md");
    const routes = [...gateway.matchAll(/path: "(\/api[^"]*)"/gu)].map((match) => match[1] ?? "");

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(reference, `${route} is not documented`).toContain(`\`${route}\``);
  });

  it("claims documentation coverage only for the plugins it actually describes", async () => {
    const readme = await readText("README.md");
    const reference = await readText("docs/README.reference.md");
    const sections = new Set([...reference.matchAll(/^### (.+)$/gmu)].map((match) => (match[1] ?? "").toLowerCase().replaceAll(/[^a-z]/gu, "")));
    const plugins = (await readdir(resolve(repositoryRoot, "packages/core/src/plugins"), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name.replace(/\.ts$/u, "").replaceAll("-", ""));
    const undocumented = plugins.filter((plugin) => !sections.has(plugin));

    // A ratchet, not a floor: documenting more plugins only lowers the count, while a plugin that arrives without a reference section pushes it over the budget. Lower the budget whenever it drops.
    expect(undocumented.length, `undocumented built-in plugins: ${undocumented.join(", ")}`).toBeLessThanOrEqual(undocumentedBudget);
    expect(readme).not.toMatch(/documents every built-in plugin/u);
    expect(reference).not.toMatch(/canonical reference for the complete plugin catalog/u);
  });

  it("documents the model the shipped web profile actually selects", async () => {
    const profile = await readText("apps/web/profile/cordis.yml");
    const reference = await readText("docs/README.reference.md");
    const readme = await readText("README.md");
    const provider = /provider: .*\?\? '([^']+)'/u.exec(profile)?.[1];
    const model = /model: .*\?\? '([^']+)'/u.exec(profile)?.[1];

    expect(provider).toBeDefined();
    expect(model).toBeDefined();
    expect(reference).toContain(`\`${provider ?? ""}/${model ?? ""}\``);
    for (const variable of ["PI_HARNESS_PROVIDER", "PI_HARNESS_MODEL"]) expect(readme, `${variable} is undocumented`).toContain(variable);
  });
});
