# @pi-harness/plugin-theme-studio

Theme Studio — Apply bounded Light, Midnight, Paper, and High Contrast presets to the Pi Harness web surface.

## Install

```sh
npm install --save-exact @pi-harness/plugin-theme-studio
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: theme-studio
  name: "@pi-harness/plugin-theme-studio"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
