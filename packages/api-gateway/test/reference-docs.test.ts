import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
      expect(text, `${path} mentions the EveryAPI CLI`).toContain("everyapi use pi-harness");
      // pi-web is EveryAPI's integration for Pi's own browser UI, another product, and a reader sent there never reaches this console.
      expect(text, `${path} routes the reader through another product's tool`).not.toContain("everyapi use pi-web");
      expect(text, `${path} says where to get the EveryAPI CLI`).toContain("https://dl.everyapi.ai/install.sh");
    }
  });

  it("documents the launcher flags that pick a model through the EveryAPI tool", async () => {
    // `everyapi use pi-harness` exports PI_HARNESS_MODEL over the caller's value and points at the flag after `--`, so a reader who only finds the variables documented has no working way to choose a model through it.
    for (const path of ["README.md", "docs/README.reference.md"]) {
      const text = await readText(path);
      for (const flag of ["--provider", "--model"]) expect(text, `${path} documents ${flag}`).toContain(`\`${flag} <id>\``);
    }
  });

  it("documents the environment variables that decide which files boot", async () => {
    // Each of these wins over, or is invisible next to, something the README already documents, so a reader who does not meet it here meets it as a directory they did not expect to be read or written.
    const readme = await readText("README.md");

    for (const variable of ["PI_HARNESS_HOME", "PI_CODING_AGENT_DIR"]) expect(readme, `${variable} is undocumented`).toContain(variable);
  });

  it("keeps every README translation translated and current on the agent directory variables", async () => {
    // A translation is read by someone who chose it over the English page, so an English sentence left in it is a sentence they may not be able to read, and the environment paragraph is where a reader learns which directory their credentials land in: a translation still naming `PI_AGENT_DIR` as the main variable sends them to the alias while the fail-closed clause two lines later names the real one.
    const translations = (await readdir(resolve(repositoryRoot, "docs"))).filter(
      (name) => /^README\.[a-zA-Z-]+\.md$/u.test(name) && name !== "README.reference.md",
    );
    expect(translations.length).toBeGreaterThanOrEqual(10);
    for (const name of translations) {
      const text = await readText(`docs/${name}`);
      expect(text, `${name} keeps the English CLI sentence`).not.toContain("canonical command-line interface");
      for (const variable of ["PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_HARNESS_HOME"])
        expect(text, `${name} does not mention ${variable}`).toContain(variable);
      expect(text.indexOf("PI_CODING_AGENT_DIR"), `${name} names PI_AGENT_DIR before PI_CODING_AGENT_DIR`).toBeLessThan(text.indexOf("PI_AGENT_DIR"));
      expect(text, `${name} still calls PI_AGENT_DIR the active agent directory`).not.toMatch(
        /`PI_AGENT_DIR` (?:النشط|activo|actif|attivo|ativo)|aktiven `PI_AGENT_DIR`|активном `PI_AGENT_DIR`|現在の `PI_AGENT_DIR`|현재 `PI_AGENT_DIR`|当前 `PI_AGENT_DIR`/u,
      );
    }
  });

  it("inventories every workspace directory under packages and apps, and no directory that is gone", async () => {
    // These two lists are what a contributor reads instead of running `ls`, so a name that has moved sends them looking for code that is not there, and an omission hides a whole workspace. The reference is narrowed to its own layout section first, because the prose elsewhere names some of these directories in passing and would otherwise satisfy the inventory on their behalf.
    const reference = await readText("docs/README.reference.md");
    const layout = /\n## Workspace layout\n(?<entries>[\S\s]*?)\n## /u.exec(reference)?.groups?.entries ?? "";
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

    expect(layout).not.toBe("");
    for (const directory of directories) expect(layout, `${directory} is missing from the workspace layout`).toContain(`\`${directory}\``);
    for (const named of [...agents.matchAll(/`((?:packages|apps)\/[a-z0-9-]+)`/gu)].map((match) => match[1] ?? ""))
      expect(directories, `AGENTS.md names ${named}, which does not exist`).toContain(named);
  });

  it("links repository files with paths that resolve from the file that carries the link", async () => {
    // A relative link is resolved against the directory of the document it sits in, so the `LICENSE` that works from the repository root 404s from docs/, and every translation repeats whatever the English page does. GitHub is where these are read, so an unresolvable target is a dead end for the reader rather than a lint detail.
    const documents = [
      "README.md",
      "AGENTS.md",
      ...(await readdir(resolve(repositoryRoot, "docs"))).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
    ];
    const links = (
      await Promise.all(
        documents.map(async (document) =>
          [...(await readText(document)).matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)/gu)].map((match) => ({ document, target: match[1] ?? "" })),
        ),
      )
    ).flat();
    const unresolved = (
      await Promise.all(
        links.map(async (link) => ({
          link,
          exists: await stat(resolve(repositoryRoot, dirname(link.document), link.target)).then(
            () => true,
            () => false,
          ),
        })),
      )
    )
      .filter((entry) => !entry.exists)
      .map((entry) => `${entry.link.document} -> ${entry.link.target}`);

    expect(documents.length).toBeGreaterThan(10);
    expect(links.length).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
  });
});
