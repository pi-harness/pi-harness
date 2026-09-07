# @pi-harness/plugin-secure-audit

Secure Audit — Read-only workspace scan for exposed credentials and dangerous shell commands with value-redacted findings.

## Install

```sh
npm install --save-exact @pi-harness/plugin-secure-audit
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: secure-audit
  name: "@pi-harness/plugin-secure-audit"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
