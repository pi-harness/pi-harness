# @pi-harness/plugin-readme-gen

README Gen — Generate README reports from strictly bounded manifest metadata and a descriptor-safe loader inventory with Markdown-safe rendering, plus confirmed no-clobber atomic writes, explicit overwrite confirmation, and cancellable sequential execution.

## Install

```sh
npm install --save-exact @pi-harness/plugin-readme-gen
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: readme-gen
  name: "@pi-harness/plugin-readme-gen"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Generate and write

`readme_report` reads the current workspace package.json and runtime loader inventory, returning a Markdown overview. It lists manifest metadata, npm script names, and reported runtime plugins; it does not infer architecture, installation instructions, or usage from source code. Script examples use POSIX shell quoting for special names and do not execute scripts during generation.

`readme_write` regenerates from the current manifest and requires `confirm: true`; the default output is README.generated.md. Replacing an existing file additionally requires `overwrite: true`. Output must be a relative README Markdown path inside the workspace. Symlinked parents and targets are rejected, writes are atomic, and overwrites preserve existing permissions. Cancellation is honored before the atomic commit; a completed commit is not rolled back by a later cancellation.

Manifest input is limited to 1 MiB and individual fields, scripts, loader entries, and plugin counts have additional bounds. Failed operations preserve the last successful report and expose their status. Missing loader data is reported as no runtime plugins, not as a scan of npm dependencies.
