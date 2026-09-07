# @pi-harness/plugin-sql-lens

SQL Lens — Inspect workspace-contained SQLite databases with strict descriptor-safe inputs, a single read-only statement, bounded results, symlink and replacement checks, timed worker execution, cancellation, and fail-closed panel reporting.

## Install

```sh
npm install --save-exact @pi-harness/plugin-sql-lens
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: sql-lens
  name: "@pi-harness/plugin-sql-lens"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.
