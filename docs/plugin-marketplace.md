# Pi Harness plugin marketplace

The marketplace is a reviewed index of Cordis plugins that can be loaded by a Pi Harness profile. The index itself is data, but the web console acts on it: its Install button makes the running harness install the package and activate the plugin, so only reviewed entries at the exact version pinned in the index can be installed, and nothing outside the index is reachable from the UI.

## Add a plugin

1. Publish the package to npm and include a public repository, license, README, and lifecycle-safe tests.
2. Verify that the package exports a Cordis plugin and document its `config`, injected services, capabilities, and hooks.
3. Add one JSON file under [`packages/api-gateway/src/marketplace-entries`](../packages/api-gateway/src/marketplace-entries), using `official` or `community` as the first directory. Validate it against [`marketplace-entry.schema.json`](./marketplace-entry.schema.json); `npm test` runs the same schema check over every shipped entry and also imports the registry through the runtime validator. The build copies these shards into the package; there is no hand-maintained aggregate registry.
4. Run `npm test`, `npm run lint`, and `git diff --check`, then open a pull request. Marketplace entries are reviewed like code; a package is not listed just because it exists on npm.

The `version` field is pinned deliberately. A version change is a reviewable marketplace update, and the package must be re-tested before the PR is merged.

## Entry contract

Each entry has a stable kebab-case `id`, an npm `packageName` (a bare package such as `@pi-harness/plugin-<name>`, or a subpath such as `@scope/toolkit/plugins/<name>` for a package that exports several plugins) and exact semver `version`, a human-readable `name` and `description`, `author`, public `https://` `repository` and `license`, `official` or `community` `source`, `verified` or `experimental` `status`, a `category` with a kebab-case `id` and a display `label`, non-empty `capabilities` and `hooks` tag arrays, and the Cordis `profile` entry the installer writes into the project profile. `profile.name` must equal `packageName`; `profile.config` is an object, or an array of child entries when `profile.group` is `true`. The JSON Schema is the structural half of this contract; `isMarketplacePlugin` in [`packages/api-gateway/src/marketplace.ts`](../packages/api-gateway/src/marketplace.ts) is authoritative, runs when the API gateway is imported, and rejects the whole registry (and therefore `npm test`) on any invalid file. Keep credentials, tokens, download counts, and unverifiable claims out of the registry; download and quality statistics are fetched from npm at runtime, never stored in entries.

## Install and enable

Install in the web console is not a copy-to-clipboard action: it POSTs to `/api/marketplace/install` and the gateway performs the change in the running harness. Every entry takes the same path, official or community: the gateway runs `npm install --save-exact --package-lock=false <packageName>@<version>` in the directory that owns the booted profile (this edits that directory's `package.json` and `node_modules`), writes a `marketplace-<id>` entry into that profile immediately ahead of the runtime entry and inside the group that owns it, then creates the loader entry at that same position and waits for the plugin to activate, which imports and runs the package inside the harness process immediately. Position matters because a plugin contributes its tools while it activates and the runtime takes the tool registry when it activates; an entry after the runtime would fail on every later start. If any step fails, the loader entry is removed, the profile, `package.json` and `package-lock.json` are restored to their previous contents, and the request fails with 502. Marketplace changes are serialized; a second install, toggle, or uninstall while one is running is rejected with 409.

A plugin that contributes tools is the one case that does not activate on the spot. The runtime holds the tool registry for its whole life and snapshots the tool set when it takes it, so such a plugin cannot join a harness that is already running. The package and the profile entry stay in place, the response carries `restartRequired: true`, the console says the change takes effect after a restart, and the plugin loads normally on the next start. Re-enabling a disabled tool plugin behaves the same way.

Because Install executes the package in-process, review the entry's repository before installing, and be aware that a profile passed with `--config` makes that project's `package.json` the install target. Enabling, disabling, and uninstalling go through `/api/plugins/toggle` and `/api/plugins/uninstall`, which edit the same profile file (uninstall also runs `npm uninstall`) and roll back on failure. Pi Harness will fail startup rather than silently ignore a missing or invalid plugin. The marketplace endpoint returns bounded pages, so the client never downloads the complete registry at once.

## The harness home

Booting a built-in profile does not boot the file inside the installed package. The launcher copies it to `~/.pi-harness/profiles/<name>/cordis.yml` on first run and boots that copy, so the profile the marketplace appends to and the `node_modules` it installs into belong to the user rather than to a directory npm replaces on every upgrade. `PI_HARNESS_HOME` overrides the location.

The copy keeps tracking the shipped profile for as long as it is untouched, so a release that changes what the harness boots still reaches an existing installation. The first marketplace install, or any hand edit, ends that: the copy now carries state the distribution does not know about and is left alone. Deleting it restores the shipped profile on the next boot, which is also the repair for a diverged copy that still names something the current release no longer installs.

A built-in profile therefore has three files under one shared install directory. `cordis.yml` is what boots, `cordis.seed.yml` records the shipped profile it was last seeded from, and `~/.pi-harness/package.json` is the manifest npm installs against. Every built-in profile shares that one `node_modules`, so a plugin installed from the web console is also resolvable by `pih`.

## Official plugins

An official plugin is not a special case of the above. Each one lives in its own workspace under [`packages/plugins`](../packages/plugins), publishes as `@pi-harness/plugin-<name>`, carries its own semver, and is installed from npm by the same route a community package takes. A fresh installation contains none of them: the shipped profiles enable infrastructure only, so an official plugin reaches a harness when the user installs it and not before. The release only bumps and republishes the plugins whose directory actually changed since the previous release tag, so a plugin's version line reflects that plugin's history rather than the launcher's. Plugins track the packages they share with the harness through caret ranges, which is what keeps a launcher patch release from rewriting every plugin manifest.

The plugins that stay inside `@pi-harness/core` are the ones a user never installs, disables, or removes: the model, models, resources, runtime, session, stdio and tools services the harness cannot boot without. They are not marketplace entries and the console shows them as loaded by the runtime, without an uninstall action.

## Review checklist

- The package is reachable from the declared repository and has a license.
- The exact version is published and the README explains configuration and permissions.
- Plugin activation and disposal are covered by tests; no global mutable singleton is required.
- Capabilities and hooks describe observable behavior rather than marketing claims.
- The profile entry has the minimum configuration needed to activate the plugin.
- The entry file is scoped to the contributor's plugin; do not edit a shared aggregate file.
