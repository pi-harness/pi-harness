# @pi-harness/plugin-genui

GenUI — Render bounded structured cards with text, badge, and decimal progress blocks while displaying HTML and scripts as plain text.

## Install

```sh
npm install --save-exact @pi-harness/plugin-genui
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: genui
  name: "@pi-harness/plugin-genui"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Card lifetime and display limits

The latest successful card and render count are kept in memory across sessions until the plugin reloads. Invalid or cancelled renders do not replace that card. This tool updates the local panel; it does not execute HTML or scripts or write a card file.

Each card supports 1–12 blocks and at most 16,384 UTF-16 code units of total text. Titles and labels are limited to 256 units, block values to 4,000. Progress is supplied as a decimal string from 0 to 100 (for example, `"87.5"`).

The panel previews at most 2,000 units of each text/badge value and displays a truncation notice when needed; tool details retain the complete accepted value. Long unbroken text wraps within its card.
