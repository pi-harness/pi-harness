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

Model-facing content includes the complete JSON report: repository descriptions, links, language, topics, update timestamps, source topics and completeness metadata, including for empty results. Topic matches remain discovery candidates, not verified installable plugins.

Model JSON is limited to 128 KiB. Reports within that budget are unchanged. Larger reports crop metadata on UTF-8 boundaries and, if necessary, omit trailing repositories; `metadataTruncated=true` and `truncated=true` disclose that the model received an incomplete report. `total` then counts the repositories actually included. Tool details retain the original network-bounded report.

Requests use HTTPS with a 1 MiB response limit per topic and `timeoutMs` (default 15000, range 1000–60000). GitHub rate limits surface as HTTP errors. Unloading the plugin cancels active requests. This plugin never installs packages or inspects locally installed plugins.
