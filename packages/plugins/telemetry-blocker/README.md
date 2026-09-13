# @pi-harness/plugin-telemetry-blocker

Telemetry Blocker provides a disabled local telemetry service and bounded event observations.

## Install

```sh
npm install --save-exact @pi-harness/plugin-telemetry-blocker
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: telemetry-blocker
  name: "@pi-harness/plugin-telemetry-blocker"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Scope and reporting

Calls to `piTelemetry.send` are discarded locally; the service has no network transport and does not read or retain event properties. `discarded` counts valid service calls. `observed` separately counts valid `pi/telemetry` bus events seen by this plugin. Other listeners still receive those bus events: observation is not interception.

This plugin does not block outbound hosts, patch fetch/HTTP, restrict subprocesses, or replace a system firewall. Model requests and unrelated plugin network activity are unaffected. There are no destination configuration keys.

The snapshot and `telemetry_status` expose `enabled: false`, `discarded`, `observed`, `names`, `namesTruncated` and an explicit scope. No `blocked` compatibility field is retained. Counters saturate at Number.MAX_SAFE_INTEGER. Up to 100 distinct normalized names are kept, each at most 80 UTF-16 units without splitting a surrogate pair; the panel displays eight. Raw names over 4096 units, control characters and empty names are invalid. Event names may themselves contain sensitive text, so callers should use fixed event identifiers.

Malformed bus events that reach this listener are ignored. Cordis may reject hostile proxies before dispatching them to the plugin. Invalid direct service calls fail explicitly, and neither entry point invokes a name accessor or reads properties. Snapshots are detached; counters and names are in-memory and reset when the plugin restarts. Status calls reject unknown parameters and cancellation, and retained service handles reject calls after disposal.
