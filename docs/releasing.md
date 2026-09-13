# Releasing

Package releases are published by the `Release packages` workflow. Desktop and mobile artifacts are built by `Desktop release` for version tags (`v*`).

Desktop artifacts are currently produced for macOS, Windows, and Ubuntu. Android builds produce unsigned CI artifacts; iOS builds use `--no-sign` for CI validation. Maintainers must configure signing credentials and notarization separately before publishing store-ready artifacts.

Before a release, verify the changelog, run the full test suite, confirm the generated icons, and check that the release contains checksums and platform-specific installation notes.
