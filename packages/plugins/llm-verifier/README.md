# @pi-harness/plugin-llm-verifier

LLM Verifier — Ask a configured verifier model to judge a claim against bounded, untrusted evidence.

## Install

```sh
npm install --save-exact @pi-harness/plugin-llm-verifier
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: llm-verifier
  name: "@pi-harness/plugin-llm-verifier"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
