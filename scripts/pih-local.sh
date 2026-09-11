#!/bin/sh

# Build the current checkout's web assets and launch the authenticated
# Pi Harness integration. EveryAPI resolves its installed server executable,
# so PI_HARNESS_WEB_DIST is used to make that server serve this checkout's UI.
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root_dir"

npm run build:web

server_entry="$root_dir/apps/web/server-dist/bin.js"
if [ ! -f "$server_entry" ]; then
  echo "Local Pi Harness server entrypoint was not produced: $server_entry" >&2
  exit 1
fi

everyapi_cli=${EVERYAPI_CLI_PATH:-everyapi}
if ! command -v "$everyapi_cli" >/dev/null 2>&1; then
  echo "EveryAPI CLI was not found: $everyapi_cli" >&2
  echo "Set EVERYAPI_CLI_PATH or install everyapi before starting Pi Harness." >&2
  exit 1
fi

export PI_HARNESS_WEB_DIST="$root_dir/apps/web/dist"
exec "$everyapi_cli" use pi-harness -- "$@"
