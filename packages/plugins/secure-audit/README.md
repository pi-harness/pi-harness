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

## Scope and limits

The scan reports heuristic matches, never executes matched commands, and does not return credential values. Standard PKCS#8, RSA, EC, DSA, OpenSSH, encrypted PEM and PGP private-key headers are recognized. A zero-match result is not proof of safety. `changed` means findings exist, not that files were modified.

Directory discovery uses bounded streaming reads: at most 4,096 entries, 512 directories, depth 16 and 500 selected files. `.git`, `.pi`, `node_modules`, `dist`, `build` and `coverage` are excluded. Directory-entry symbolic links are not traversed. Requested paths and discovered paths are resolved within the workspace before access. Files exceeding 512 KiB, NUL-containing files, invalid UTF-8 and unreadable files are skipped. `scanned` counts selected candidate files, including skipped candidates; `skipped` also includes unreadable directories.

Results retain at most 200 findings while preserving total severity counts. Model-visible tool text includes coverage limitations, skipped counts and redacted finding locations. `truncated` identifies discovery or output truncation; `incomplete` identifies incomplete content coverage. General credential assignments on lines longer than 4,096 characters are skipped and counted separately; key/value windows and heuristic false positives/negatives still apply. Other patterns continue to inspect those lines. Filesystem reads are not an atomic snapshot, so avoid concurrently replacing directories during a scan.

Tool cancellation or plugin disposal rejects pending scans and prevents publishing results. Failed scans retain the last successful report. The panel distinguishes the initial unscanned state; returned reports and panel snapshots are detached.

## Native sessions

The tool scans the active native session workspace, or the launch directory when no runtime exists. Changing the session, manager, session ID, or cwd resets the panel to its unscanned state. Pending scans check their scope at filesystem boundaries and reject stale results before caching or returning them. A same-session failure retains the last successful report.
