# Pi Harness plugin marketplace

The marketplace is a reviewed index of Cordis plugins that can be loaded by a Pi Harness profile. The index is intentionally data-only: the web UI never executes a package install or imports an unreviewed module on behalf of a user.

## Add a plugin

1. Publish the package to npm and include a public repository, license, README, and lifecycle-safe tests.
2. Verify that the package exports a Cordis plugin and document its `config`, injected services, capabilities, and hooks.
3. Add one entry to [`packages/api-gateway/src/marketplace-registry.json`](../packages/api-gateway/src/marketplace-registry.json). Validate it against [`marketplace-entry.schema.json`](./marketplace-entry.schema.json).
4. Run `npm test`, `npm run lint`, and `git diff --check`, then open a pull request. Marketplace entries are reviewed like code; a package is not listed just because it exists on npm.

The `version` field is pinned deliberately. A version change is a reviewable marketplace update, and the package must be re-tested before the PR is merged.

## Entry contract

Each entry has a stable kebab-case `id`, an npm `packageName` and exact semver `version`, a human-readable description, public repository and license, `official` or `community` source, `verified` or `experimental` status, capability and hook tags, and the Cordis profile entry to paste into a project profile. Keep credentials, tokens, download counts, and unverifiable claims out of the registry.

## Install and enable

The UI's install action copies two things: `npm install --save-exact <package>@<version>` and the profile entry. Review the package source and lockfile changes, run the project's tests, then add the entry to the profile that owns the plugin tree. Pi Harness will fail startup rather than silently ignore a missing or invalid plugin.

## Review checklist

- The package is reachable from the declared repository and has a license.
- The exact version is published and the README explains configuration and permissions.
- Plugin activation and disposal are covered by tests; no global mutable singleton is required.
- Capabilities and hooks describe observable behavior rather than marketing claims.
- The profile entry has the minimum configuration needed to activate the plugin.
