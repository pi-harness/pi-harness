# Pi Harness Desktop

The desktop app is a Tauri 2 shell around the React web console. The release build bundles the web assets, server distribution, profile, and platform icons.

## Development

From the repository root:

```sh
npm run dev -w @pi-harness/desktop
```

The desktop process starts the local web server and navigates the main window to `http://127.0.0.1:3141/` after the server is ready.

## Build

```sh
npm run build -w @pi-harness/desktop
npm run bundle:macos -w @pi-harness/desktop
```

The first command builds the React frontend and Tauri bundle for the host platform. The macOS command emits an `.app` and `.dmg`.

## Runtime configuration

The bundled launcher discovers `server-dist/bin.js` and `dist/` under Tauri's resource directory. Set `PI_HARNESS_SERVER_BIN` to override the runtime executable and `PI_HARNESS_SERVER_SCRIPT` to override the server script, which is useful for development and platform-specific sidecars. The default runtime is `node`.
