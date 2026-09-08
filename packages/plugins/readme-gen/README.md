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

## Native sessions

Both tools read the active native session workspace, or the launch directory when no runtime exists. A write uses the same captured workspace as its regenerated report. Changing the session, manager, session ID, or cwd clears the report, last-write receipt, and operation status. Pending operations reject stale results without overwriting the new session's status.

The atomic writer checks session ownership after staging and immediately before linking or renaming the README into place. A switch before this check leaves an existing README unchanged and removes the staging file. A filesystem operation already submitted cannot be undone by a later switch; a committed file is not rolled back, and empty parent directories created before cancellation or switching may remain.

Runtime plugin inventory follows the current Cordis Loader Entry contract: every entry has a data `fiber` property, and an undefined fiber means the entry is inactive. Entries without this property are rejected; legacy `options.disabled` fallback is not supported.
