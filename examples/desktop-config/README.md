# Desktop configuration example

Use the Tauri shell with a locally built web server:

```sh
PI_HARNESS_SERVER_SCRIPT="$PWD/apps/web/server-dist/bin.js" \
npm run dev -w @pi-harness/desktop
```

The desktop shell starts the server, waits for port `3141`, and navigates the window to the console. `PI_HARNESS_SERVER_BIN` can point to a platform-specific Node or Bun runtime.
