# Changelog

All notable changes to Pi Harness are documented here. Entries are grouped by release and describe user-visible behavior.

## Unreleased

- Community contribution, governance, security, support, and plugin ecosystem guidance.
- Tauri desktop and mobile build workflows.
- The built-in `default` and `development` CLI profiles now select `everyapi/deepseek-v4-flash` through `PI_HARNESS_PROVIDER` and `PI_HARNESS_MODEL`, the same pair and the same overrides the web console already used, so the one documented provisioning step boots both surfaces. Migration: an upgrade re-seeds a harness-home profile copy that is still byte-identical to its seed, so a `pih` run that relied on the previous `deepseek/deepseek-v4-flash` default now needs either the EveryAPI catalog (`everyapi use pi-web`) or `PI_HARNESS_PROVIDER=deepseek PI_HARNESS_MODEL=deepseek-v4-flash`; a copy that was edited by hand or by the plugin center is left alone and keeps booting what it names.

## Release notes

Release entries should include breaking changes, migration steps, security fixes, and links to the relevant pull requests. Automated dependency-only updates may be grouped together.
