# @pi-harness/plugin-plugin-radar

Plugin Radar — Discover public Pi Harness repositories on GitHub, sorted by stars.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-radar
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-radar
  name: "@pi-harness/plugin-plugin-radar"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Search

Call `plugin_radar_search` with an optional `query` (up to 80 characters). It searches only the `pi-harness` and `pi-harness-plugin` GitHub topics, deduplicates repositories, and returns up to `limit` results (default 10, maximum 25). GitHub topic tags are discovery metadata, not an endorsement or proof that a repository contains an installable plugin.

`total` counts returned repositories. `truncated` signals additional candidates, an incomplete GitHub response, or a configured result limit; it is not a count of all matching repositories. The panel shows the latest successful search. Invalid responses and failed or cancelled requests preserve it.

Requests use HTTPS with a 1 MiB response limit per topic and `timeoutMs` (default 15000, range 1000–60000). GitHub rate limits surface as HTTP errors. Unloading the plugin cancels active requests. This plugin never installs packages or inspects locally installed plugins.
