# @pi-harness/plugin-docker-sandbox

Docker Sandbox — Run descriptor-safe argv commands with local-only Docker images, no container network, a read-only workspace by default, fixed CPU, memory, and PID limits, sanitized output, strict panel reporting, and cancellation cleanup.

## Install

```sh
npm install --save-exact @pi-harness/plugin-docker-sandbox
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: docker-sandbox
  name: "@pi-harness/plugin-docker-sandbox"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native workspace

`sandbox_exec` binds both the workspace mount and the Docker client working directory to the native session that initiated the call. Before a native session is available, it uses the harness launch directory. Session replacement, session ID changes, or workspace changes clear the prior panel result. The scope is checked after image inspection, immediately before container startup, and before returning a result.

A session change prevents a pending container from starting and discards results from an older scope. It does not immediately interrupt an already-started container; existing run timeouts and caller/disposal cancellation cleanup still apply, and completed writes cannot be rolled back. Writable mounts continue to require both `write=true` and `confirmWrite=true`.

If Docker auto-removal races explicit cleanup, the plugin waits up to 10 additional seconds for Docker to confirm the container is absent. Permission errors, other inspection failures, and removal timeouts remain cleanup errors.
