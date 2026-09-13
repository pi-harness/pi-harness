# @pi-harness/plugin-plugin-stars

Plugin Stars — Search an explicitly configured Pi Harness repository snapshot and rank it by GitHub stars.

## Install

```sh
npm install --save-exact @pi-harness/plugin-plugin-stars
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: plugin-stars
  name: "@pi-harness/plugin-plugin-stars"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Ranking source

There is no default ranking feed. Configure `sourceUrl` with your curated Pi Harness JSON at `https://raw.githubusercontent.com`. With no source configured, the panel reports the missing configuration and `plugin_stars_search` fails before networking. The old DSH ranking is no longer used.

The JSON must contain `source` (nonempty name), `generatedAt` (UTC ISO timestamp), and `plugins` (at most 1000 entries). Each entry requires `id`, `name`, `fullName` (`owner/repository`), `htmlUrl` (the matching GitHub HTTPS URL), `stars` (nonnegative safe integer), `updatedAt` (UTC ISO timestamp), and `topics` (up to 24 strings). Optional fields are `description`, `homepage`, `npmName`, and `license`; a homepage must be an HTTP or HTTPS URL without credentials. Duplicate IDs or repositories invalidate the complete response.

`plugin_stars_search` accepts an optional `query` (up to 120 characters), filters the snapshot locally, and sorts by stars. The model receives the complete bounded report as JSON, including source metadata and every field for each returned repository. `total` counts all matches, `truncated` states whether the configured result limit omitted matches, and `limit` bounds returned entries (default 10, maximum 50). The panel receives at most 20 entries and renders eight. GitHub stars are snapshot metrics, not user ratings or installation compatibility guarantees.

Requests reject redirects, use a 2 MiB response bound, and default to a 15-second timeout. Caller cancellation, timeout or unloading also cancels a response body that stalls after headers; response cleanup is best effort and cannot replace the size or protocol diagnostic. Failed and cancelled requests preserve the latest successful ranking.
