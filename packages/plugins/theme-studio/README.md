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

## State and scope

`theme_set` requires exactly one `theme` value: `light`, `midnight`, `paper`, or `high-contrast`. `theme_status` accepts an empty object. Both return the complete current state, including session ID, timestamp, and detached color tokens. Unknown configuration keys and raw tool properties are rejected. Cancelled, disposed, and session-switched requests cannot change the selection. Each request captures the native AgentSession, manager, and journal header before parameter inspection and checks that scope before reading or appending state and before returning the result.

The latest `pi-harness/theme-studio` custom entry in the current native session journal is authoritative; reads do not retain a startup-only selection. A new session uses the configured default. Selection applies session-wide, across branches in that journal. `changed` indicates that the session contains a persisted selection, and `changedAt` is that selection's timestamp, including after reopening. Entries use the current `{ theme, changedAt }` format without legacy migration. Native in-memory sessions stay in memory, and native journal flushing rules still apply before the first assistant entry.

A failed native append may have changed the SDK's in-memory journal before the disk error. Theme Studio quarantines that manager/header until the session is reopened from disk or replaced; it does not report the failed selection as applied. The panel reports the same error, and the web surface stops applying that invalid theme snapshot. Registrations are removed on disposal or initialization failure.

The web client accepts only the bounded color token names and literal hex/RGBA colors, then applies them to the workbench root and the session action/tool menus rendered outside that root. It applies a panel theme only when the snapshot session ID matches the active session, so a failed panel refresh after a session switch cannot retain the previous session's theme. Neutral surfaces, text, borders, form controls, and paired status foregrounds/backgrounds follow the selected theme; terminal/code output and solid decorative indicators retain their own palettes. Presets are not an accessibility conformance certification. The plugin does not change terminal themes, operating-system appearance, or external embedded content.
