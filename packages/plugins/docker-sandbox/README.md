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
