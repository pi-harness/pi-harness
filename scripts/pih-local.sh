#!/bin/sh

# Build and launch the current checkout through EveryAPI's authenticated
# pi-harness integration. The temporary PATH shim prevents EveryAPI from
# selecting an older globally installed pi-harness binary.
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

shim_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-harness-local.XXXXXX")
cleanup() {
  rm -f "$shim_dir/pi-harness"
  rmdir "$shim_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

ln -s "$server_entry" "$shim_dir/pi-harness"
PATH="$shim_dir:$PATH" "$everyapi_cli" use pi-harness "$@"
