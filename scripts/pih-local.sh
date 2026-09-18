#!/bin/sh

# Build and launch the current checkout through EveryAPI's authenticated pi-harness integration, the tool EveryAPI ships for this product (pi-web is its integration for Pi's own browser UI). The temporary PATH shim makes EveryAPI invoke this checkout's server rather than a potentially stale global installation.
set -eu

case "${1:-}" in
  -h|--help)
    printf '%s\n' \
      'Usage: npm run pih-local -- [pi-harness options]' \
      '' \
      'Build and launch this checkout through EveryAPI authenticated pi-harness.' \
      'Set PIH_LOCAL_CWD to launch the agent in another project directory.' \
      'All options are forwarded to the local Pi Harness server, so pass --model <id> here to pick the model; everyapi use pi-harness exports its own PI_HARNESS_MODEL.'
    exit 0
    ;;
esac

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
launch_dir=${PIH_LOCAL_CWD:-${INIT_CWD:-$(pwd)}}
if ! launch_dir=$(CDPATH= cd -- "$launch_dir" 2>/dev/null && pwd); then
  echo "Pi Harness local working directory does not exist: $launch_dir" >&2
  exit 1
fi
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

printf '%s\n' '#!/bin/sh' 'exec node "$PIH_LOCAL_SERVER_ENTRY" "$@"' > "$shim_dir/pi-harness"
chmod 755 "$shim_dir/pi-harness"
export PIH_LOCAL_SERVER_ENTRY="$server_entry"
if [ -z "${PI_CODING_AGENT_DIR:-}" ] && [ -n "${PI_AGENT_DIR:-}" ]; then
  export PI_CODING_AGENT_DIR="$PI_AGENT_DIR"
fi
cd "$launch_dir"
PATH="$shim_dir:$PATH" "$everyapi_cli" use pi-harness -- "$@"
