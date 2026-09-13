# @pi-harness/plugin-web-research

Web Research — Search the public web through a configurable provider and return bounded, cited source evidence.

## Install

```sh
npm install --save-exact @pi-harness/plugin-web-research
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: web-research
  name: "@pi-harness/plugin-web-research"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Behavior and configuration

`web_search` sends a 2–500 character query to the configured Firecrawl v2 `/search` endpoint. `baseUrl` defaults to `https://api.firecrawl.dev`; `apiKey` uses the configured nonempty value or `FIRECRAWL_API_KEY`. An absent key means no Authorization header is sent, not a guarantee that the provider accepts anonymous requests. Non-loopback endpoints require HTTPS when a key is present. The panel indicates configuration only, not verified authentication.

`maxResults` defaults to 8 and is clamped to 1–20. `timeoutMs` defaults to 20,000 and is clamped to 1,000–120,000. Responses must be valid UTF-8 JSON and fit within 1 MiB, including streamed bodies. Results use HTTP/HTTPS URLs without embedded credentials, capped at 4,096 characters; title, snippet, and publication date fields are capped at 500, 4,000, and 100 characters. Invalid entries within the first requested number of provider results are skipped. Search snippets are third-party evidence, enclosed in an untrusted-content envelope; they are not instructions or independently verified claims. A provider failure flag or no usable results produces a degraded report.

`read_page` requires Browser Fetch to be enabled and delegates URL fetching, network restrictions, response limits, and page-content handling to that plugin. Its optional `focus` is a note of at most 2,000 characters returned in details; it does not filter or summarize the page. URLs must be credential-free HTTP/HTTPS and at most 4,096 characters. Both tools reject unknown parameters and accessor properties.

Caller cancellation and plugin disposal cancel active searches and propagate to delegated page reads. Retained tool references cannot start work after disposal, and cancelled results cannot replace the last completed search. Returned search details and panel snapshots are detached copies. The panel displays up to eight results from the last completed search; failed requests leave that previous result visible. The configured endpoint receives the query, and Browser Fetch contacts the selected page separately. No model call is made by this plugin itself.
