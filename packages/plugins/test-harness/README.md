# @pi-harness/plugin-test-harness

Test Harness — Run five fixed npm script names from a trusted workspace, reporting real status with a sanitized 12 KiB UTF-8-safe untrusted output tail, a bounded configurable timeout, and cancellable process-tree cleanup.

## Install

```sh
npm install --save-exact @pi-harness/plugin-test-harness
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: test-harness
  name: "@pi-harness/plugin-test-harness"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Execution contract

`run_project_tests` accepts only `{ script?: "test" | "build" | "format:check" | "lint" | "typecheck" }`; an omitted script means `test`. It runs in the active native SessionManager workspace, using the launch directory only before a runtime exists. Results and the panel include the captured `cwd`. Concurrent calls are rejected. If the session or workspace changes while a run is in progress, its result is rejected and does not replace the previous panel result; completed script side effects are not rolled back. A previous panel result remains labeled with its own execution directory.

`timeoutMs` is an integer from 100 through 600000 (default 120000). Cancellation and disposal stop the process. On POSIX, termination targets the detached process group even when the npm leader has exited but descendants still hold output pipes. SIGTERM escalates to SIGKILL after one second, and inherited output pipes are closed then to bound waiting. Windows uses `taskkill /T /F` with direct-child fallback. Descendants that deliberately detach into a different process group, or Windows descendants whose ancestry is no longer available, are not guaranteed to be terminated. This is process cleanup, not an OS sandbox.

These are fixed script names, not restricted script bodies: npm can execute project commands and pre/post lifecycle scripts with the harness user's filesystem, environment, and network access. Use a trusted workspace. The tool does not install dependencies or select a package manager based on project lockfiles. It invokes the inherited absolute `npm_execpath` through Node when present, otherwise system npm; the inherited path must point to a Node-compatible npm CLI.

The latest run is kept in memory. Status distinguishes passed, failed, timed-out, and cancelled; cancellation rejects the tool call but records the cancelled run when the plugin remains active. Stdout and stderr are combined in arrival order with a 12 KiB raw tail and a second UTF-8 output bound. The raw byte counter counts all observed bytes, not the rendered text length. Terminal sequences and unsafe controls are sanitized; credentials and ordinary secret text are not redacted. Output remains untrusted text. The model receives report metadata plus the bounded output, and the panel shows the same run. Neither tool success nor a zero exit code proves that the project's tests cover its requirements.
