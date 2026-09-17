import { readdir, readFile, stat } from "node:fs/promises";
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

  it("ships CLI profiles the documented provisioning step can actually boot", async () => {
    // The quickstart names exactly one way to provision a catalog, and it registers everyapi alone. A CLI profile that pinned some other provider would make the second command of that quickstart fail on a machine the first command just prepared.
    const web = await readText("apps/web/profile/cordis.yml");
    const selection = (profile: string): string =>
      `${/provider: .*\?\? '([^']+)'/u.exec(profile)?.[1] ?? ""}/${/model: .*\?\? '([^']+)'/u.exec(profile)?.[1] ?? ""}`;

    for (const profile of ["packages/cli/profiles/default/cordis.yml", "packages/cli/profiles/development/cordis.yml"])
      expect(selection(await readText(profile)), `${profile} diverges from the web profile`).toBe(selection(web));
  });

  it("names where to obtain the EveryAPI CLI everywhere it tells the reader to run it", async () => {
    // The console is fail-closed on an unprovisioned catalog, so a reader who cannot get this binary cannot reach the UI at all, and the tool is not on npm.
    for (const path of ["README.md", "docs/README.reference.md"]) {
      const text = await readText(path);
      expect(text, `${path} mentions the EveryAPI CLI`).toContain("everyapi use pi-web");
      expect(text, `${path} says where to get the EveryAPI CLI`).toContain("https://dl.everyapi.ai/install.sh");
    }
  });

  it("documents the environment variables that decide which files boot", async () => {
    // Each of these wins over, or is invisible next to, something the README already documents, so a reader who does not meet it here meets it as a directory they did not expect to be read or written.
    const readme = await readText("README.md");

    for (const variable of ["PI_HARNESS_HOME", "PI_CODING_AGENT_DIR"]) expect(readme, `${variable} is undocumented`).toContain(variable);
  });

  it("inventories every workspace directory under packages and apps, and no directory that is gone", async () => {
    // These two lists are what a contributor reads instead of running `ls`, so a name that has moved sends them looking for code that is not there, and an omission hides a whole workspace.
    const reference = await readText("docs/README.reference.md");
    const agents = await readText("AGENTS.md");
    const directories = (
      await Promise.all(
        ["packages", "apps"].map(async (parent) =>
          (await readdir(resolve(repositoryRoot, parent), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${parent}/${entry.name}`),
        ),
      )
    ).flat();

    for (const directory of directories) expect(reference, `${directory} is missing from the workspace layout`).toContain(`\`${directory}\``);
    for (const named of [...agents.matchAll(/`((?:packages|apps)\/[a-z0-9-]+)`/gu)].map((match) => match[1] ?? ""))
      expect(directories, `AGENTS.md names ${named}, which does not exist`).toContain(named);
  });

  it("links repository files with paths that resolve from the docs directory", async () => {
    // Every link in this file is resolved relative to docs/, so one written as if it sat at the repository root 404s on GitHub, which is where most readers open it.
    const reference = await readText("docs/README.reference.md");
    const targets = [...reference.matchAll(/\]\((?!https?:|#)([^)#]+)/gu)].map((match) => match[1] ?? "");
    const unresolved = (
      await Promise.all(
        targets.map(async (target) => ({
          target,
          exists: await stat(resolve(repositoryRoot, "docs", target)).then(
            () => true,
            () => false,
          ),
        })),
      )
    )
      .filter((entry) => !entry.exists)
      .map((entry) => entry.target);

    expect(targets.length).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
  });
});
