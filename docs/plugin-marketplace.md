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

Install in the web console is not a copy-to-clipboard action: it POSTs to `/api/marketplace/install` and the gateway performs the change in the running harness. Every entry takes the same path, official or community: the gateway runs `npm install --save-exact --package-lock=false <packageName>@<version>` in the harness working directory (this edits that project's `package.json` and `node_modules`), appends a `marketplace-<id>` entry to the profile file the harness was started from, then creates the loader entry and waits for the plugin to activate, which imports and runs the package inside the harness process immediately. If any step fails, the loader entry is removed, the profile, `package.json` and `package-lock.json` are restored to their previous contents, and the request fails with 502. Marketplace changes are serialized; a second install, toggle, or uninstall while one is running is rejected with 409.

Because Install executes the package in-process, run the web console against a project whose `package.json` and profile you are willing to have modified, and review the entry's repository before installing. Enabling, disabling, and uninstalling go through `/api/plugins/toggle` and `/api/plugins/uninstall`, which edit the same profile file (uninstall also runs `npm uninstall`) and roll back on failure. Pi Harness will fail startup rather than silently ignore a missing or invalid plugin. The marketplace endpoint returns bounded pages, so the client never downloads the complete registry at once.

## Official plugins

An official plugin is not a special case of the above. Each one lives in its own workspace under [`packages/plugins`](../packages/plugins), publishes as `@pi-harness/plugin-<name>`, carries its own semver, and is installed from npm by the same route a community package takes. The release only bumps and republishes the plugins whose directory actually changed since the previous release tag, so a plugin's version line reflects that plugin's history rather than the launcher's. Plugins track the packages they share with the harness through caret ranges, which is what keeps a launcher patch release from rewriting every plugin manifest.

The plugins that stay inside `@pi-harness/core` are the ones a user never installs, disables, or removes: the model, models, resources, runtime, session, stdio and tools services the harness cannot boot without. They are not marketplace entries and the console shows them as loaded by the runtime, without an uninstall action.

## Review checklist

- The package is reachable from the declared repository and has a license.
- The exact version is published and the README explains configuration and permissions.
- Plugin activation and disposal are covered by tests; no global mutable singleton is required.
- Capabilities and hooks describe observable behavior rather than marketing claims.
- The profile entry has the minimum configuration needed to activate the plugin.
- The entry file is scoped to the contributor's plugin; do not edit a shared aggregate file.
