# @pi-harness/plugin-modlens

ModLens Vision Bridge — Send bounded workspace images to native vision models or return schema-validated evidence from the bundled ModLens engine for text-only models.

## Install

```sh
npm install --save-exact @pi-harness/plugin-modlens
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: modlens
  name: "@pi-harness/plugin-modlens"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native sessions

Image paths resolve inside the active native session workspace, or the launch directory when no runtime exists. The evidence engine continues to run with the image's containing directory as cwd and receives a private snapshot of the validated image bytes. Session, manager, session ID, or cwd changes clear image metadata, operation status, and cached evidence.

Pending operations check session ownership before filesystem and engine work and after the engine's snapshot cleanup. Stale successes and failures cannot populate the new session's result or cache. An engine already started can continue to consume its configured provider quota until it finishes or the existing timeout/caller cancellation/disposal stops it; switching sessions discards its result rather than undoing an external request.
