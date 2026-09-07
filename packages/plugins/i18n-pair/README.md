# @pi-harness/plugin-i18n-pair

I18n Pair — Strict read-only comparison of bounded JSON locale files from no-follow workspace paths, with collision-safe missing and extra keys, stable failures, cancellation, and validated panel status.

## Install

```sh
npm install --save-exact @pi-harness/plugin-i18n-pair
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: i18n-pair
  name: "@pi-harness/plugin-i18n-pair"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
