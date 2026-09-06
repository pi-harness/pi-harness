# Pi Harness

Pi Harness is a plugin-first web host for [Pi](https://github.com/earendil-works/pi) built on the published DeepSeek Cordis stack. The browser console, HTTP API, static asset server, models, resources, sessions, tools, runtime, logging, timers, and HMR are Cordis plugins. A CLI surface remains available for scripted and terminal workflows.

## Requirements

- Node.js 22.19 or newer
- npm 10 or newer
- Provider credentials supported by Pi for real model requests

## Run from source

```sh
npm ci
npm run build
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js "Explain this repository"
```

## Install the published harness

Users install the single entry package; the scoped `@pi-harness/*` packages are implementation dependencies pulled in automatically.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

On normal startup, Pi Harness performs a best-effort, non-blocking check for a newer compatible `@pi-harness/core` release. If one is available, it prints the update command to stderr; network failures are ignored and startup continues normally. Set `PI_HARNESS_DISABLE_UPDATE_CHECK=1` to disable the check (useful for offline or restricted environments).

## Run the web console

```sh
npm ci
npm run web
```

The web launcher builds the Vite browser bundle, starts the Cordis host, and prints a local URL (by default `http://127.0.0.1:3141`). Set `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, and `PI_AGENT_DIR` to change the bind address, port, or Pi state directory. The browser surface is served by the bundled `@pi-harness/web-app` plugin and talks to the bundled `@pi-harness/api-gateway` over `/api/status`, `/api/session`, `/api/sessions`, `/api/session/new`, `/api/session/open`, `/api/models`, `/api/model`, `/api/files`, `/api/prompt`, `/api/abort`, and the `/api/events` Server-Sent Events stream. The launcher refuses non-loopback hosts unless `PI_HARNESS_ALLOW_REMOTE=1` is explicitly set on a trusted network; the API is intended for local use and has no user authentication layer.

The default profile selects `deepseek/deepseek-v4-flash`, stores JSONL sessions under `$PI_AGENT_DIR/sessions`, and loads Pi resources from the current project and agent directory. `PI_AGENT_DIR` defaults to `~/.pi/agent`. When the EveryAPI CLI is installed, launch the integrated web surface with `everyapi use pi-harness`; it provisions an isolated Pi agent directory with the EveryAPI provider catalog and starts Pi Harness on its local loopback URL.

## Architecture

```text
web launcher / CLI launcher
└── Cordis Context
    ├── Loader
    └── Include(profile YAML)
        └── Group
            ├── models      -> piModelRuntime
            ├── resources   -> piResources + extension providers
            ├── model       -> piModels
            ├── session     -> piSession
            ├── tools       -> piTools
            ├── runtime     -> piRuntime
            ├── webserver  -> webServer
            ├── api        -> HTTP JSON routes
            ├── web-app    -> static Vite bundle + SPA fallback
            └── stdio      -> piApplication
```

An application plugin implements `run(signal?: AbortSignal): Promise<number>`. The signal is aborted when a signal or an exit request ends the run, and a surface that can block must unwind on it; the launcher force-exits one that does not.

Cordis owns module loading, configuration validation, dependency injection, activation ordering, lifecycle effects, rollback, grouping, and development HMR. Pi owns model discovery, project resources, session persistence, tool execution, provider calls, and agent events. There is no parallel plugin registry or lifecycle abstraction.

## CLI

```sh
# Built-in production profile
pih --profile default "Summarize the current directory"

# Built-in development profile with logger, timer, and HMR
pih --profile development "Summarize the current directory"

# Project-owned Cordis entry tree
pih --config ./cordis.yml "Summarize the current directory"

# Inspect a profile without importing plugins
pih --profile default --dump-config
```

Launcher options are `--profile`, `--config`, `--dump-config`, `--help`, and `--version`. `--profile` and `--config` also accept the inline `--profile=<name>` and `--config=<path>` spellings. The launcher stops recognizing its own options at the first argument that is not one of them, so `pih explain what tar -h prints` sends the whole sentence to the agent instead of printing usage.

Remaining arguments are passed unchanged to the active application plugin, including a `--` separator, which the launcher forwards rather than consuming. The bundled stdio application accepts `--prompt <text>`, `--prompt=<text>`, a positional prompt, or piped stdin, and rejects an option-shaped positional prompt unless `--` precedes it:

```sh
pih -- -v is a version flag, explain it
```

Prompts are limited to 1,048,576 UTF-8 bytes at both the CLI input layer and the application boundary. Interactive Ctrl-C, process signals, and host shutdown cancel a pending prompt or model request and use exit code 130 for the bundled stdio surface.

`PI_AGENT_DIR` must name an absolute directory. An empty or whitespace-only value is treated as unset, and a relative value is resolved against the invocation directory, so the credential store can never land in the current working directory by accident.

The built-in development profile watches the invocation working directory and the launcher automatically supervises a child process with Node's `--expose-internals` flag, which Cordis HMR requires. Cordis performs partial plugin reloads in place and requests a supervised process restart when a framework module changes. The supervisor backs off between restarts and gives up after five restarts in ten seconds so a reload loop cannot fork processes without bound. Production does not expose Node internals.

A custom profile that mounts `@deepseek-ai/cordis-plugin-hmr` must start the CLI entry with `node --expose-internals`. Such a process is not supervised, so a Cordis full-reload request writes a diagnostic to stderr and leaves the run in place instead of terminating with a restart exit code that nothing would act on.

## Profiles

Profiles are YAML arrays of Cordis Loader entries. Every entry needs a stable `id`, a module `name`, and optional `config`, `inject`, `group`, or `disabled` fields. IDs must be unique across the complete entry tree because Cordis groups share their owning tree's entry store.

Bare module specifiers resolve from the directory containing the profile, so a project profile can name any plugin installed in that project. Relative specifiers resolve from the same directory. Ids must be unique across the complete entry tree, and a collision fails startup rather than silently dropping one of the colliding entries.

Pi Harness reads and hot-refreshes profile files but does not persist Loader mutations back into them. This prevents an activation rollback from rewriting a source profile; edit the YAML directly to make changes.

## Selected core production plugins

Pi Harness ships the production-oriented plugins below. The built-in `default` profile enables the entries listed in [`packages/core/profiles/default/cordis.yml`](packages/core/profiles/default/cordis.yml); other core plugins, such as Graph Memory, can be added to a project-owned profile when needed. Plugin panels expose the latest bounded result and the limits applied by the backend.

| Plugin             | Tools                                                                                     | Purpose                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Models             | —                                                                                         | Load the isolated Pi model/auth catalogs with strict selection IDs, bounded refresh, and fail-closed config errors. |
| Resources          | —                                                                                         | Load cwd-bound Pi resources behind explicit project trust with bounded diagnostics and fail-closed extensions.      |
| Model              | —                                                                                         | Select the exact configured model after resource extensions register providers, without an implicit fallback.       |
| Session            | —                                                                                         | Own a new in-memory or append-only JSONL conversation tree with validated, deterministic storage paths.             |
| Tools              | —                                                                                         | Build a bounded tool allowlist and lifecycle-owned custom-tool/UI registries for the active Runtime.                |
| Agent Team Board   | `team_task`                                                                               | Maintain a branch-aware collaboration ledger of roles, dependency-gated tasks, and session-local mailbox notes.     |
| ModLens            | `vision_inspect`                                                                          | Give native vision models bounded images and text-only models structured evidence from a separate vision engine.    |
| Vision Toolkit     | `vision_catalog`, `vision_image_info`                                                     | Catalog bounded workspace image metadata locally with verified formats, dimensions, and explicit partial results.   |
| Git Time Capsule   | `git_snapshot`, `git_restore`                                                             | Capture a byte-exact validated unstaged diff, then deterministically reverse-apply it after explicit confirmation.  |
| Dependency Checker | `dependency_check`                                                                        | Check bounded local dependency presence and declaration consistency without installing or executing packages.       |
| @file Context      | `file_context`                                                                            | Attach one bounded workspace text file as explicitly untrusted model-context data.                                  |
| Test Harness       | `run_project_tests`                                                                       | Run one fixed-name npm verification script with bounded output, timeout, cancellation, and real exit status.        |
| Session Insights   | `session_report`                                                                          | Inspect validated session accounting and queue explicitly confirmed, lifecycle-safe compaction.                     |
| README Generator   | `readme_report`, `readme_write`                                                           | Render a bounded Markdown-safe project overview and write only to an explicitly confirmed README path.              |
| Graph Memory       | `graph_memory_record`, `graph_memory_link`, `graph_memory_search`, `graph_memory_forget`  | Persist bounded typed nodes and directed relations across sessions in the Pi agent directory.                       |
| I18n Pair          | `i18n_check`                                                                              | Compare two workspace-contained JSON locale files without modifying either file.                                    |
| Cleaner            | `clean_harness_artifacts`                                                                 | Preview and remove old Git capsule patches from the dedicated Pi agent directory after explicit confirmation.       |
| SQL Lens           | `sql_readonly`                                                                            | Run one bounded read-only SQLite inspection in an isolated, cancellable query worker.                               |
| Docker Sandbox     | `sandbox_exec`                                                                            | Run a direct argv command in a fixed-resource, no-network container using a local image only.                       |
| Browser Fetch      | `browser_fetch`                                                                           | Fetch bounded textual HTTP responses with per-hop SSRF validation, DNS pinning, cancellation, and timeout.          |
| Browser Session    | `browser_tabs`, `browser_navigate`, `browser_read`, `browser_click`, `browser_screenshot` | Inspect and control an isolated local Chrome session through a loopback-only, bounded CDP connection.               |
| Plugin Stars       | `plugin_stars_search`                                                                     | Search a strictly validated, bounded snapshot of the curated public DSH plugin ranking without installing anything. |
| YAML Validator     | `yaml_validate`                                                                           | Parse bounded workspace YAML as strict UTF-8 and report line-aware errors and warnings without modifying the file.  |
| Plugin Dev         | `plugin_dev_reload`                                                                       | Safely reload Pi session extensions and resources after trusted local development changes.                          |
| OpenPets           | `pet_react`                                                                               | Maintain a bounded companion state from session events without retaining message contents.                          |
| Session Bridge     | `session_bridge_export`, `session_bridge_preview`, `session_bridge_import`                | Preview and move a bounded, reviewable handoff into another active session.                                         |
| Skill Guard        | `skill_guard_scan`                                                                        | Audit the bounded entry Markdown of loaded Skills and report heuristic risk labels.                                 |
| Recall Unread      | `session_recall_unread`                                                                   | Find current-workspace Pi sessions whose latest valid message is an unanswered user request.                        |
| Turn Rewind        | `session_rewind`                                                                          | Queue a bounded, UI-aware native session-tree rewind while preserving the abandoned branch.                         |
| Context Doctor     | `context_doctor`                                                                          | Audit bounded context health and run confirmed, lifecycle-safe manual compaction.                                   |
| Runtime            | —                                                                                         | Own the active AgentSession, bind tools and extensions, forward events, and serialize lifecycle teardown.           |
| Context Insights   | `context_inspect`                                                                         | Inspect bounded context usage, message composition, and active-session lifecycle counters without message content.  |
| Token Guard        | —                                                                                         | Stop an active run once its context percentage or optional billed run-token budget reaches a strict threshold.      |
| Failure Logger     | —                                                                                         | Aggregate bounded extension, Agent, and non-aborted compaction failures with safe diagnostic summaries.             |
| Stdio              | —                                                                                         | Run one bounded prompt with clean stdout, structured stderr diagnostics, signal cancellation, and flushed output.   |
| MCP Client         | `mcp_list_tools`, `mcp_call`, `mcp_server_*`, resource and prompt tools                   | Bridge bounded MCP stdio tools, resources, and prompts with managed process lifecycle and cancellation.             |

### Models

Models owns Pi's provider catalog and credential-backed `ModelRuntime`. It isolates `auth.json`, `models.json`, and the refreshed `models-store.json` under `PI_AGENT_DIR`; it never falls back to files in the invocation directory. The configured provider identifier is limited to 128 characters and the model identifier to 512, and both must be non-empty machine identifiers without whitespace or terminal control characters. Unknown plugin options and malformed or schema-invalid `models.json` files fail activation before the runtime service is published rather than silently reverting to built-in defaults.

`refreshOnCreate` defaults to `false`, so normal startup restores only local model data and does not opt into model-catalog network access. When explicitly enabled, the upstream refresh is allowed to use the network but receives a fixed 15-second startup deadline. The service is lifecycle-owned by Cordis and disappears on activation rollback or disposal.

### Resources

Resources builds Pi's cwd-bound settings and resource loader on the shared model runtime. It loads extensions, Skills, prompt templates, themes, `SYSTEM.md`/`APPEND_SYSTEM.md`, and context files from the active project and `PI_AGENT_DIR`, while preserving source metadata for downstream plugins. Every target cwd must be an absolute path to an existing directory; session switches receive a fresh service set, so settings, trust decisions, resources, and diagnostics cannot leak from the previous cwd.

Project `.pi` settings and executable resources require trust. With the default empty configuration, the closest saved decision in `$PI_AGENT_DIR/trust.json` applies and an unrecorded project is treated as untrusted because the Harness surfaces cannot display Pi's interactive trust prompt. `trustProject: true` or `false` is an explicit per-profile override and wins over saved decisions. User-owned resources under `PI_AGENT_DIR` still load for an untrusted project, and ordinary `AGENTS.md`/`CLAUDE.md` context files follow Pi's upstream policy of loading independently of project trust. Trust is an input-loading guard, not a sandbox for tools or model actions.

Each resource category can be disabled independently:

```yaml
- id: resources
  name: "@pi-harness/core/plugins/resources"
  config:
    trustProject: false
    noExtensions: true
    noSkills: true
    noPromptTemplates: true
    noThemes: true
    noContextFiles: true
```

Unknown options, non-boolean flags, invalid target directories, extension import failures, and provider-registration failures abort activation before `piResources` is published. Skill, prompt, theme, settings, trust, and HTTP dispatcher diagnostics are retained for the application surface; each message is normalized to one line and limited to 2,048 characters, while the inventory keeps 99 entries plus an explicit omission summary. Omitted errors remain fatal. Non-fatal warnings are emitted on stderr by the bundled stdio plugin. Global `httpProxy` and HTTP idle-timeout settings are applied through Pi's own dispatcher for both the initial cwd and rebuilt cwd services, so provider traffic shares the same proxy-aware network stack. Cordis removes the service when activation rolls back or the plugin unloads.

### Model

Model waits for both the model runtime and Pi resources before resolving the configured provider/model pair. That ordering lets trusted Pi extensions register a declared provider during resource loading before selection occurs. The selected object is the exact model registered in the shared runtime; a missing provider or model aborts activation with its full identifier instead of falling back to another provider, model, or backend.

The plugin accepts only an empty configuration object. Scalar, array, and unknown-key configurations fail before `piModels` is published, and Cordis removes the selected-model service when the plugin rolls back or unloads.

### Session

Session creates the native Pi `SessionManager` consumed by Runtime and the session-oriented plugins. `storage: jsonl` is the default and starts a new append-only version 3 conversation tree under `$PI_AGENT_DIR/sessions`. A custom `directory` may be absolute or relative to the launch cwd; missing directories are created before the service is published. The path must contain 1–4,096 characters, include at least one non-whitespace character, contain no C0/C1 control characters, and resolve to an actual directory rather than a file.

```yaml
- id: session
  name: "@pi-harness/core/plugins/session"
  config:
    storage: jsonl
    directory: var/pi-sessions
```

Pi intentionally defers creating a new JSONL file until the conversation has an assistant message. At that point the header and all preceding entries are flushed together, preventing abandoned prompts from leaving misleading empty session files; subsequent entries append to the same tree. Session switching, forking, compaction, and resuming remain native `SessionManager` behavior owned by Runtime.

Use `storage: memory` for ephemeral runs. Memory sessions never expose a session file or write a transcript, and configuring `directory` with memory storage is rejected rather than silently ignored. Unknown options, invalid option types, unsafe paths, and unusable directory targets fail activation before `piSession` is published. Cordis removes the service on rollback or disposal; the downstream Runtime owns active-session shutdown.

### Tools

Tools publishes the lifecycle-owned registries consumed by Runtime and bundled plugins. Its default allowlist is Pi's standard `read`, `bash`, `edit`, and `write` set. Use `names: []` to disable Pi's built-ins and resource-extension tools, or list any of Pi's built-ins plus tools that trusted resource extensions register during `session_start`. Harness plugins contributed through `piTools` remain enabled in either case:

```yaml
- id: tools
  name: "@pi-harness/core/plugins/tools"
  config:
    names: [read, grep, find, ls, project_search]
```

The allowlist accepts at most 256 unique names. Each name is limited to 128 characters and cannot contain whitespace or Unicode control characters. Harness plugins register their custom tools through the same registry; those tools are included automatically in Runtime's immutable startup snapshot and cannot shadow an explicitly configured name or a Pi built-in. Runtime leases the snapshot for the lifetime of the active AgentSession, so late Harness registrations fail instead of silently disappearing or mutating a running session.

After Pi binds resource extensions, Runtime verifies that every requested name is actually registered and aborts activation when any tool is missing. Extension tools that exist but are absent from the profile allowlist remain disabled and produce a diagnostic instead of vanishing without explanation. The default four tools are covered by a real runtime integration test that writes, reads, edits, and invokes `bash` inside an isolated workspace. Cordis removes both `piTools` and `piPluginUi` on rollback or disposal.

### Agent Team Board

Agent Team Board provides `team_task`, a durable collaboration ledger inside the current Pi session. It does not start another Agent, invoke a model, create a process, or send a message outside the session. The named members are roles recorded on the board; independent teammates must be launched explicitly by a separate, user-authorized system. The tool supports `get_state`, `add_task`, `update_task`, `claim_task`, `remove_task`, `add_member`, `remove_member`, `send_message`, `read_messages`, and `clear_messages`.

Member and task IDs contain 1–64 ASCII letters, digits, underscores, or hyphens and must start with a letter or digit. A board holds at most 64 members, 256 tasks, 256 dependencies per task, and 1,000 mailbox notes; titles, member names, and roles are limited to 200 characters, and message bodies to 4,000. A task becomes ready only after every dependency is complete. Claiming with an explicit assignee selects an unassigned task or one already assigned to that member—it never steals work from another member. Dependency cycles, unknown references, impossible in-progress/completed states, and duplicate identities are rejected before persistence.

Mailbox bodies are treated as untrusted collaboration context, not as user approval or authorization. `read_messages` returns and marks at most 25 matching notes per call and reports how many remain. `remove_task`, `remove_member`, and `clear_messages` require `confirm: true`; only completed leaf tasks, unreferenced members, and read notes can be removed. Agent-facing state text is capped at 32 KiB. The backend and browser panels display at most 12 members, 20 tasks, and 5 messages while retaining complete inventory, ready-task, and unread counts.

State follows Pi's active session branch and is limited to 8 MiB after canonical reconstruction. Recovery checks the newest 10,000 branch entries first, then continues backward only when no valid Agent Teams checkpoint or legacy state exists in that window, so a long-lived board cannot silently reset after unrelated conversation traffic. A versioned journal stores one checkpoint followed by ID-based deltas and writes a fresh checkpoint after at most 512 deltas, avoiding repeated full-mailbox snapshots while keeping state reconstruction bounded. Legacy full snapshots remain readable, corrupt deltas are rejected atomically, and unsafe newer state falls back to the newest valid checkpoint. These custom session entries do not enter the model context; only the bounded result of an explicit `team_task` call does.

### ModLens

`vision_inspect` is a real vision bridge rather than an image metadata placeholder. On every tool execution it checks the current model's declared input capabilities. A model that accepts images receives a bounded image block directly. A text-only model—including the default `deepseek/deepseek-v4-flash` profile model—runs the version-locked `@liustack/modlens@3.25.4` CLI and receives structured OCR, layout, semantic, visual, and uncertainty evidence. The result must match the bundled ModLens vision schema before it reaches the Agent.

The bundled CLI is used by default. ModLens provider credentials and engine selection are managed by ModLens itself; verify that setup before relying on the text-model bridge:

```sh
npx @liustack/modlens doctor
```

An advanced profile may select a trusted absolute CLI file and set a 1–300 second deadline:

```yaml
- id: modlens
  name: "@pi-harness/core/plugins/modlens"
  config:
    cliPath: /absolute/path/to/trusted/modlens-cli.mjs
    timeoutMs: 180000
```

The external engine may access the network, consume provider quota, and incur provider charges. Its output is prefixed as untrusted visual evidence: image text is data, not an instruction and not user authorization. The browser panel receives only bounded status and image metadata, never the full OCR evidence.

Input is limited to a regular local PNG, JPEG, GIF, or WebP file contained in the active workspace. The final file is opened without following a replacement symlink, capped at 10 MiB, and checked against its extension using image magic bytes. Text-model execution receives a private `0600` snapshot of those validated bytes rather than reopening the mutable workspace path, and the snapshot is removed after success, failure, cancellation, timeout, or disposal. Complete image decoding remains the native model or ModLens provider's responsibility. Paths are limited to 4,096 characters and optional focus prompts to 4,000.

CLI stdout is capped at 1 MiB, validated evidence at 512 KiB, Agent-facing evidence text at 128 KiB with UTF-8-safe truncation, and surfaced errors at 2,000 characters. Successful evidence is cached by image content plus focus in a 64-entry LRU, so repeated inspection does not repeatedly consume provider quota. Calls execute sequentially. Caller cancellation, timeout, and plugin disposal terminate the CLI process tree; a graceful termination escalates to forced termination after one second on POSIX, while Windows uses process-tree termination.

### Vision Toolkit

`vision_catalog` inventories image metadata across the active workspace, while `vision_image_info` strictly inspects one relative path. Both are local, read-only operations: they do not upload an image, invoke a vision provider, decode pixels, or modify the workspace. Agent-facing file names are marked as untrusted data, Unicode control characters are escaped, and catalog text is capped at 16 KiB on a valid UTF-8 boundary.

PNG, JPEG, GIF, and WebP extensions are checked against their file signatures before metadata is accepted. PNG IHDR, GIF logical-screen, JPEG SOF, and all three WebP bitstream forms (`VP8X`, `VP8L`, and `VP8 `) provide dimensions. Each regular file is capped at 20 MiB, opened without following a replacement symlink, and only its first 256 KiB is read. A JPEG whose SOF follows that header budget remains listed with unknown dimensions and an explicit header-truncated flag; other malformed or mismatched headers are rejected. This is bounded header inspection, not complete image decoding or integrity verification.

Catalog traversal is deterministic within each bounded directory sample and skips `.git` and `node_modules`. One malformed or inaccessible image becomes an issue rather than hiding the remaining valid assets. A run returns at most 100 valid assets, examines at most 256 image candidates, scans at most 4,096 directory entries across 512 directories and 16 levels, and exposes at most 20 issue details of 500 characters each. Every partial condition is reported through `truncated` or `issuesTruncated`; caller cancellation and plugin disposal stop in-flight scans. The dedicated browser panel validates this contract again before displaying status, counts, assets, issues, formats, and limits.

### Git Time Capsule

`git_snapshot` captures only the current unstaged changes to tracked files. It intentionally excludes staged and untracked changes and rejects a clean worktree instead of writing an empty capsule. Git output stays byte-exact, and repository textconv or external diff drivers are disabled so a configured display filter cannot execute or turn the capsule into a non-applicable patch. The captured patch is validated from a private `0600` temporary file and atomically published through an exclusive same-directory hard link; an existing final name is never overwritten, and incomplete or invalid captures are removed instead of appearing in the inventory. Agent-facing results expose only the capsule filename, never its private absolute path.

`git_restore` requires `confirm: true`, reads at most 8 MiB without following a replacement capsule symlink, snapshots those verified bytes privately, checks the complete reverse application, and then applies that same snapshot to the working tree without touching the index. Repository-targeting Git environment variables are ignored, and whitespace policy is pinned for deterministic restores. A source capsule being replaced or removed after the private read cannot change the applied bytes or turn a completed restore into a reported failure.

Capture and restore operations execute sequentially and honor caller cancellation, timeout, and plugin disposal. At most 256 capsules are accepted; a full inventory or 4,096-entry capsule directory rejects another capture before the panel can become unusable. Directory scans stop at that same 4,096-entry boundary, the panel returns at most the 20 newest capsules with exact total/truncation metadata, and both backend and browser sanitize or reject malformed names, counts, errors, accessors, proxies, unknown contract fields, and contradictory limits before display.

### Dependency Checker

`dependency_check` performs an offline, read-only inspection of one dependency manifest inside the active workspace. It defaults to `package.json`; pass a relative `requirements*.txt` path when checking Python dependencies:

```json
{
  "manifest": "services/api/requirements-prod.txt"
}
```

For npm, the checker reads `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies`, including optional peer metadata. It searches `node_modules` from the manifest directory up to the workspace root and reports required and optional packages separately. When the same package has multiple semver declarations, compatibility means that all declarations have at least one common version—not merely that every pair overlaps. A duplicate group containing a non-semver form such as `workspace:*`, a Git reference, or a tag is reported as unresolved instead of being guessed compatible or incompatible.

For Python, the checker recognizes exact distribution directories, common module files, and versioned `.dist-info` or `.egg-info` entries in workspace-contained `.venv` and `venv` layouts. Requirement names are normalized according to Python distribution-name rules. Conflict analysis intentionally supports only an explicit numeric subset of PEP 440: equality and ordering operators, compatible releases, comma-separated conjunctions, and supported wildcards. Environment markers, direct references, arbitrary equality, and other unsupported constraint syntax are reported as unresolved. Pip directives such as `-r` and `--index-url`, plus standalone VCS or URL requirements, are reported as invalid; the checker never follows included files or contacts an index.

The result distinguishes `missing`, `optionalMissing`, `invalid`, `conflicts`, and `unresolved`. A manifest is limited to 1 MiB and 2,000 total declarations or invalid requirement lines. Python analysis accepts at most 64 distinct constraints per package and scans at most 4,096 environment directory entries across all candidate virtual environments. Tool calls execute sequentially and honor cancellation and plugin disposal. The browser independently validates the report, shows at most 20 entries per issue list, six conflict or unresolved groups, and eight constraints per group, and marks altered or omitted detail as truncated.

This is a presence and declaration-consistency check, not a package resolver. It does not read installed package versions, prove that an installed version satisfies a declaration, implement all of PEP 440/508, install dependencies, execute manifest content, invoke a model or provider, use the network, or modify the workspace. Path, file, and parser failures use stable diagnostics that do not embed absolute workspace paths or Node's raw JSON parser excerpts.

### @file Context

`file_context` attaches one local text file to the model context. It accepts only a relative path inside the active workspace; the requested path and its canonical target must both stay inside that workspace. Input paths are limited to 512 characters and 512 UTF-8 bytes, cannot have leading or trailing whitespace, and cannot contain Unicode control characters. The target must resolve to a regular file, and the final read uses no-follow semantics so a replacement symbolic link is rejected.

Each attachment is capped at 256 KiB and decoded as strict UTF-8. Invalid byte sequences and NUL bytes are rejected; a UTF-8 byte-order mark is consumed during decoding. The Agent-facing value is framed as `<file path="…" untrusted="true">`. File paths are escaped before entering the attribute, and case or whitespace variants of a closing `</file>` tag inside the content are neutralized so file data cannot terminate its wrapper.

The operation is offline and read-only: it does not execute the file, treat instructions inside it as user authorization, invoke a model or provider, use the network, or modify the workspace. Calls execute sequentially and honor caller cancellation and plugin disposal. Tool results and panel snapshots are detached from internal state; the browser independently validates the fixed 256 KiB contract, path and byte fields, unknown properties, accessors, proxies, Unicode controls, and contradictory values, then displays altered or rejected data as incomplete rather than healthy.

### Test Harness

`run_project_tests` executes exactly one of `test`, `build`, `format:check`, `lint`, or `typecheck`, defaulting to `test`. Tool parameters must be a plain object with no unknown fields, and the schema publishes the same literal allowlist. Calls are serialized so two verification scripts cannot mutate or saturate the same workspace concurrently. The default profile applies a 120,000 ms timeout; `timeoutMs` accepts integer values from 100 through 600,000 ms.

The runner invokes npm with fixed process arguments and never interpolates model-provided shell text. npm still executes the selected command—and its npm lifecycle hooks—from the workspace's own `package.json` using the platform's script shell. The allowlist therefore limits selectable script names, not what those scripts can do. Project scripts inherit the Harness process permissions and environment and may execute arbitrary code, modify files, start processes, access credentials, or use the network. Run Test Harness only in a trusted workspace; it is not a sandbox or a read-only check.

Combined stdout and stderr are counted without unbounded buffering, while only the newest 12 KiB is retained on UTF-8 code-point boundaries. Terminal escape sequences and unsafe control characters are removed or replaced, and output is wrapped as untrusted `<test-output>` data with embedded closing-tag variants neutralized. Results distinguish passed, failed, timed-out, and cancelled runs and report the real exit code or signal, duration, total output bytes, truncation, and sanitization.

Caller cancellation, timeout, and plugin disposal terminate the npm process tree. POSIX launches use an isolated process group with graceful `SIGTERM` followed by `SIGKILL` after one second; Windows cleanup uses `taskkill /T /F`. Tool results and panel reads are detached snapshots. The browser validates descriptors, exact fields, script/command pairing, status/exit-code consistency, output accounting, fixed display limits, and timeout bounds before rendering a wrapped output preview; malformed or altered data is labeled incomplete.

### Session Insights

`session_report` reads Pi's native statistics for the active session without duplicating conversation storage. With no arguments it is read-only and reports the session ID, user and assistant message counts, tool calls and results, cumulative input, output, cache-read, and cache-write tokens, cumulative cost, and current context usage:

```json
{}
```

The cumulative token and cost totals cover all native session entries, including usage recorded by earlier compactions; they are billing-oriented session totals, not just the messages currently retained in the model context. Current context usage is a separate estimate. Immediately after compaction, Pi intentionally reports its token count and percentage as unknown until a later model response provides trustworthy post-compaction usage; the panel shows that state instead of substituting zero.

Statistics cross a strict validation boundary before reaching the tool or panel. Session identifiers, message and token counts, finite non-negative cost, token-total arithmetic, categorized-message accounting, context-window values, nullable context usage, and percentage arithmetic are checked without invoking accessors. Reports and nested values are detached snapshots. Repeated panel polling uses a session-aware cache; explicit tool reads, relevant message/tool/agent/entry/compaction events, and active-session replacement refresh it. The browser independently repeats descriptor-safe structural and accounting checks and refuses to render malformed statistics as healthy values.

Manual compaction is an explicit model-backed side effect and requires both flags:

```json
{
  "compact": true,
  "confirm": true
}
```

Compaction can call the active model, consume provider quota, incur cost, and replace older context with a generated summary. When an Agent run is active, Session Insights records one queued request and returns before starting it; the request begins only after Pi emits the authoritative `agent_settled` event, so the current tool result can finish normally. An idle session starts immediately. A second queued or running request is rejected rather than overlapped.

Caller cancellation before a queued request starts removes it. Cancellation during compaction and plugin disposal call Pi's dedicated `abortCompaction()` API rather than aborting unrelated Agent work. Session replacement cancels work bound to the old session. The panel exposes `idle`, `queued`, `running`, `completed`, `failed`, or `cancelled` state with ordered timestamps and descriptor-safe error text limited to 2,000 characters. Parameter objects reject unknown or symbol properties, accessors, unsupported prototypes, and non-boolean flags; tool calls execute sequentially.

### README Generator

`readme_report` creates a Markdown project overview from the current workspace's `package.json` and the configured Cordis loader inventory. It is read-only, takes an empty object, and returns the rendered document together with detached metadata:

```json
{}
```

The manifest is read as a no-follow regular file and is limited to 1 MiB. Optional `name`, `version`, and `description` fields must be strings when present; names and versions must be non-empty and trimmed. Package names, versions, descriptions, and script names reject Unicode control characters. Names are limited to 256 characters and 512 UTF-8 bytes, versions to 128 characters and 256 bytes, descriptions to 4,096 characters and bytes, and script inventories to 256 names of at most 256 characters and 512 bytes each. Invalid JSON produces a stable error without exposing parser offsets or absolute paths.

The loader scan examines at most 1,024 entries and reports at most 256 unique non-Cordis plugin names. Entry options are read through data-property descriptors, so accessors and revoked proxies are rejected without being invoked. Plugin names are limited to 256 characters and 512 UTF-8 bytes. Package and plugin metadata is treated as plain text: Markdown syntax is escaped, control characters cannot create new blocks, and code-span fences expand around embedded backticks.

`readme_write` always regenerates immediately before writing, so a previous report cannot make it persist stale manifest or plugin data. The default target is `README.generated.md`:

```json
{
  "confirm": true
}
```

An explicit target must be a relative POSIX path whose final name matches `README.md` or a variant such as `README.generated.md`. Paths are limited to 512 characters and 512 UTF-8 bytes; absolute paths, backslashes, empty, dot, or parent segments, surrounding segment whitespace, Unicode controls, symbolic-link parents, symbolic-link targets, and non-file targets are rejected. Missing ordinary directories are created one segment at a time after validation.

Creating a new target requires `confirm: true`. Replacing an existing regular README requires both confirmation flags:

```json
{
  "outputPath": "docs/README.md",
  "confirm": true,
  "overwrite": true
}
```

Writes use an exclusive same-directory temporary file and an atomic publish step. No-clobber creation is enforced by the filesystem rather than by a preflight check, and same-target writes are serialized in invocation order. Both tools reject unknown keys, Symbols, accessors, arrays, unsupported prototypes, and incorrectly typed values. They execute sequentially, honor caller cancellation and plugin disposal, and publish `idle`, `running`, `completed`, `failed`, or `cancelled` status with bounded descriptor-safe errors. Tool results, cached reports, write receipts, and panel reads are detached; the browser independently validates every field and displays malformed data as unavailable rather than as zero-valued success.

README generation is local and deterministic. It does not execute package scripts, load manifest code, invoke a model or provider, use the network, or write anywhere unless `readme_write` receives explicit confirmation.

### Graph Memory

Graph Memory stores `task`, `skill`, and `event` nodes with validated directed relations. The default `graph-memory.json` file is written atomically under `PI_AGENT_DIR`, protected by an ownership-aware lock, and limited to 2,000 nodes, 5,000 relations, and 4 MiB. Search is ranked and bounded; forgetting data requires explicit confirmation.

### I18n Pair

`i18n_check` defaults to `locales/en.json` as the base and `locales/zh-CN.json` as the target. Pass either path explicitly when a project uses different locale names:

```json
{
  "base": "locales/en.json",
  "target": "locales/ja.json"
}
```

The tool reports leaf keys present only in the base as `missing` and keys present only in the target as `extra`. Both paths must be relative, trimmed, display-safe workspace paths of at most 4,096 characters and UTF-8 bytes. It reads regular valid UTF-8 JSON objects only, follows neither final-file symbolic links nor parent links outside the workspace, emits stable read/parse errors without absolute paths or JSON fragments, and never rewrites translations. Each file is limited to 4 MiB, 128 object levels, 50,000 flattened keys, and 2,048 characters and UTF-8 bytes per displayed flattened key; Unicode control characters are rejected in paths and keys.

Dotted nested paths use familiar output such as `actions.save`; literal dotted or otherwise ambiguous segments use bracket notation such as `["actions.save"]`, so structurally different keys cannot collide. The empty config and tool parameters reject unknown keys, Symbols, accessors, arrays, unsupported prototypes, and incorrectly typed values. Checks execute sequentially, honor caller cancellation and plugin disposal, and fully roll back registration failures. Tool details contain the complete bounded result; the panel retains the last successful report across later failures and publishes bounded status and inventories. The browser independently validates field shapes, count invariants, timestamps, limits, and list uniqueness, and displays malformed payloads as unavailable rather than inventing zero-valued parity.

### Cleaner

`clean_harness_artifacts` removes regular `.patch` files only from the dedicated `PI_AGENT_DIR/capsules` directory; it never deletes project files. The call must include `confirm: true` and keeps the five newest capsules by default. Set `keep` from `0` through `256` to choose another retention count:

```json
{
  "confirm": true,
  "keep": 10
}
```

Cleaner refuses symbolic-link or replaced capsule directories, revalidates each file's device and inode immediately before deletion, serializes concurrent cleanup calls, and honors caller and plugin-shutdown cancellation. It scans at most 4,096 directory entries and accepts at most 256 capsule files. A capsule name must be trimmed, end in `.patch`, contain no Unicode control characters, and fit within both 255 characters and 255 UTF-8 bytes. Unsafe names still count toward the directory scan limit, but Cleaner never displays or deletes them.

The plugin has a strict empty configuration. Tool parameters reject unknown keys, Symbols, accessors, arrays, unsupported prototypes, revoked proxies, and incorrectly typed values without invoking getters. The schema forbids additional properties and declares sequential execution. If either the tool or panel cannot register, activation rolls back every surface. Errors shown in the panel are descriptor-safe, stripped of Unicode controls, and bounded to 2,000 characters and UTF-8 bytes.

The panel publishes at most 20 recent capsules plus the last running, completed, failed, or cancelled cleanup, including partial deletion counts when an operation does not finish. The browser independently validates the complete payload, inventory invariants, unique display-safe names, exact limits, ISO timestamps, activity shapes, and removal counts. Malformed data is shown as unavailable rather than as an empty or successful cleanup. Cleaner is local-only: it does not invoke a model or provider, use the network, or touch project files.

### SQL Lens

`sql_readonly` opens a workspace-contained SQLite database in read-only mode and accepts one result-producing `SELECT`, `WITH`, or allow-listed read-only `PRAGMA` statement. The default query lists entries in `sqlite_master`; pass a database and query explicitly for application data:

```json
{
  "database": "var/app.db",
  "query": "SELECT id, name FROM users WHERE active = 1 ORDER BY id"
}
```

SQL syntax is compiled by SQLite, so comparison operators, comments, semicolons inside strings, and words such as `update` inside data are handled correctly. Additional statements, write operations, non-result queries, duplicate output column names, external paths, replaced files, and symbolic-link sidecars are rejected. The tool accepts only plain data objects with the two documented parameters; inherited keys, accessors, revoked proxies, symbols, and unknown properties are rejected without invoking user code. Queries run in a disposable Worker with a 5-second default timeout and terminate on caller cancellation or plugin shutdown, preventing expensive synchronous SQLite work from blocking the host.

The database plus `-wal`, `-shm`, and `-journal` sidecars are limited to 256 MiB in total and must remain regular files throughout the query. A result returns at most 100 rows, 128 columns, 16,384 characters per string, 1 MiB of serialized row data, and a 256-byte base64 preview for each BLOB. The plugin panel applies a smaller 20-row backend inventory and a 12-row browser display boundary. The panel validates its complete payload, row/column inventory, exact operational limits, ISO timestamps, and bounded cell values independently; contradictory or malformed data is rendered as unavailable rather than as an empty or successful result.

### Docker Sandbox

`sandbox_exec` accepts an executable and its arguments as an array. Inputs must be plain descriptor-safe data (no inherited keys, accessors, symbols, or extra argv properties); shell wrappers such as `sh`, `bash`, and `powershell` are rejected, so the tool never interpolates a command string. The image must already exist locally: Docker is invoked with `--pull=never`, and the default is `alpine:3.20`.

```json
{
  "command": ["node", "--version"],
  "image": "node:22-alpine"
}
```

Every container has networking disabled, a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, a 512 MiB memory limit, one CPU, a 256-process limit, and a 120-second runtime timeout. The workspace bind mount is read-only by default. A writable mount requires both `write: true` and `confirmWrite: true` because code inside the image can then modify project files.

Docker output is stripped of terminal/control characters and retained as a UTF-8-safe 12,000-byte tail, argv is limited to 128 non-empty entries and 128 KiB in total, and the browser panel independently validates and bounds its run/default payload before rendering. Malformed panel data is shown as unavailable rather than as an empty or successful run. Caller cancellation and plugin shutdown terminate the Docker CLI and force-remove only the uniquely named container identified by its private cidfile; cleanup failure is surfaced instead of being reported as a successful cancellation.

### Browser Fetch

`browser_fetch` performs a plain HTTP GET and returns response source as text without executing scripts, loading subresources, retaining cookies, or rendering the page. It accepts only one descriptor-safe `url` parameter (plain data object, no inherited keys, accessors, symbols, or extras), rejects credentials and non-HTTP(S) schemes, and limits URLs to 4,096 characters.

```yaml
- id: browser-fetch
  name: "@pi-harness/core/plugins/browser-fetch"
  config:
    allowPrivate: false
    timeoutMs: 20000
```

With the safe default, every original or redirected hostname is resolved before connection. The request is pinned to the validated addresses, and the entire target is rejected when any answer is local, private, link-local, shared, documentation-only, multicast, or otherwise non-public. Only Fetch redirect statuses 301, 302, 303, 307, and 308 are followed, every hop is revalidated, and at most three redirects are allowed. This closes the DNS check-to-connect rebinding gap; application-level validation is still best paired with network egress controls in high-risk deployments.

`allowPrivate: true` intentionally disables the private-target and DNS-pinning guard so trusted local development servers can be reached. It also permits link-local and cloud-metadata endpoints, so do not enable it for untrusted URLs or shared production agents.

The configurable whole-request timeout covers DNS lookup, redirects, response headers, and body streaming and is restricted to 100–60,000 ms. Decompressed response data is capped at 512 KiB and decoded as UTF-8. Only textual MIME types (`text/*`, JSON, XML, JavaScript, SQL, GraphQL, form data, and SVG) are accepted; rejected response and redirect bodies are cancelled. Tool results preserve the bounded response, while the plugin panel independently validates the complete response and limit payload and exposes only a normalized 12,000-character preview with explicit network- and preview-truncation flags. Malformed panel data is shown as unavailable. Caller cancellation and plugin disposal abort in-flight DNS and body work.

### Browser Session

Browser Session connects to an already-running Chrome DevTools Protocol endpoint and provides five tools: `browser_tabs`, `browser_navigate`, `browser_read`, `browser_click`, and `browser_screenshot`. Start a dedicated browser profile bound to loopback, then enable the plugin with the matching endpoint:

```sh
google-chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pi-harness-browser-session
```

```yaml
- id: browser-session
  name: "@pi-harness/core/plugins/browser-session"
  config:
    endpoint: "http://127.0.0.1:9222"
```

The endpoint must be an uncredentialed HTTP URL on `localhost`, `127.0.0.1`, or `::1`, up to 2,048 characters. A tab's WebSocket debugger URL must also use loopback and the configured endpoint port. Discovery rejects redirects, responses above 1 MiB, inventories above 256 targets, and malformed target descriptors. Target IDs are limited to 512 characters, titles to 4,096, URLs to 8,192, types to 64, and debugger URLs to 2,048; none may contain NUL characters. The Agent-facing tab summary is capped at 128 KiB and marks truncation while retaining the complete bounded inventory in tool details.

Every discovery or CDP request has a 15-second timeout and honors caller cancellation and plugin shutdown. CDP responses are limited to 12 MiB and must contain one valid result or error envelope. Page reads return at most 128 KiB without splitting UTF-8 characters, and screenshots are validated PNG base64 payloads of at most 8 MiB. Screenshot bytes are returned only as image content; tool details and panel state retain metadata, not the base64 payload. The backend panel publishes at most 20 tabs and 12,000 characters of the latest read, while the browser UI independently validates the complete panel payload and displays at most eight tabs; malformed panel data is shown as unavailable.

`browser_navigate` and `browser_click` change live page state. Treat a CDP endpoint as full browser-control authority: bind it only to loopback, never expose the debugging port through a proxy or tunnel, and do not attach Browser Session to a personal profile containing authenticated or sensitive tabs. Use a dedicated temporary profile and close it when the task is complete.

### Plugin Stars

`plugin_stars_search` fetches the public `dsh-plugin-stars` snapshot, validates it, filters locally by name, repository, description, or topic, and sorts matches by Star count. It is read-only and never downloads or installs a listed repository. The optional descriptor-safe `query` is limited to 120 characters.

```yaml
- id: plugin-stars
  name: "@pi-harness/core/plugins/plugin-stars"
  config:
    sourceUrl: "https://raw.githubusercontent.com/ywsldxk/dsh-plugin-stars/main/data/plugins.json"
    limit: 10
    timeoutMs: 15000
```

The source must be an uncredentialed `https://raw.githubusercontent.com` URL of at most 2,048 characters, and redirects are rejected so a configured GitHub source cannot switch hosts. Requests time out after 1–60 seconds, defaulting to 15 seconds, and caller cancellation or plugin shutdown aborts both header and body work. Unsuccessful and oversized response bodies are cancelled. The response is limited to 2 MiB, must be valid UTF-8 JSON, and must contain a source label, generation timestamp, and no more than 1,000 strictly validated, uniquely identified repositories.

Repository metadata has explicit per-field boundaries: IDs 64 characters, names 256, owner/repository names 512, descriptions and URLs 4,096, timestamps and licenses 64, npm names 256, and at most 24 topics of 64 characters each. Repository links must be uncredentialed `https://github.com` URLs matching the declared owner/repository name. Star counts must be non-negative safe integers. Invalid entries reject the snapshot instead of silently publishing a partial ranking.

The result limit is 1–50, with a default of 10. Tool parameters are descriptor-safe and reject inherited keys, accessors, symbols, and unknown properties. Tool details report the complete match count and retain only the configured number of sorted matches. The backend panel publishes at most 20 entries with explicit inventory metadata, and the browser independently validates the complete payload before displaying at most eight. Malformed panel data is shown as unavailable. Ranking content and Star counts are third-party snapshot evidence, not a security review or completeness guarantee; inspect a repository before choosing to install it through a separate, explicit workflow.

### YAML Validator

`yaml_validate` parses one existing YAML file without modifying it. Pass a workspace-relative path of at most 4,096 characters:

```json
{
  "path": "config/deployment.yml"
}
```

The descriptor-safe input rejects unknown properties, accessors, empty paths, NUL characters, and paths whose canonical target leaves the active workspace. The file is read through one bounded file handle, must be a regular file no larger than 512 KiB, and must contain valid UTF-8. Caller cancellation and plugin shutdown are checked before and after filesystem and parsing phases; cancelled or failed attempts are recorded separately and do not replace the last completed report.

Validation uses the YAML Document API to preserve line and column diagnostics without converting documents to JavaScript values or expanding aliases. One stream may contain at most 100 documents. Reports retain at most 1,000 errors and warnings combined, with complete counts and an explicit truncation flag; each message is limited to 2,000 characters. Agent text and the backend panel show at most 50 diagnostics, while the browser normalizes all fields and displays at most 20. The panel also exposes bounded completed, failed, or cancelled status.

### Plugin Dev

`plugin_dev_reload` reloads the active Pi session's extensions, skills, prompts, themes, and context files after local development changes. The legacy tool name is retained for compatibility; it does not install packages and is not a replacement for compiling TypeScript or for Cordis HMR of Harness plugins.

```json
{
  "reason": "reload the edited local extension"
}
```

The optional reason is descriptor-safe and rejects accessors, unknown or symbol properties, non-plain parameter objects, NUL characters, and values longer than 1,000 characters. Empty or omitted reasons use `manual plugin reload`. Tool details and panel reads return independent snapshots. Panel errors are limited to 2,000 characters, and the backend publishes both limits explicitly.

Reload is a side effect that runs extension shutdown and startup hooks and loads executable local resources, so enable this plugin only in a trusted local development environment. When an Agent turn is active, the tool records one queued request and returns before reloading; it waits for the authoritative `agent_settled` event so the current tool result can be persisted safely. An idle session reloads immediately. A second queued or running request is rejected instead of overlapping `AgentSession.reload()` calls.

Caller cancellation before start prevents the reload. The upstream reload API has no cancellation signal once it begins, so later caller cancellation or plugin disposal stops that caller from waiting but does not claim that the underlying reload stopped; its eventual success or failure still determines the internal final state. States are exposed as `idle`, `queued`, `running`, `reloaded`, `failed`, or `cancelled`, with bounded reasons, errors, and timestamps.

### OpenPets

OpenPets maintains a small companion state in append-only Pi custom session entries. These entries are explicitly excluded from the LLM context: the plugin stores only its bounded state fields and never retains prompt, response, or tool content. On activation it inspects at most the newest 10,000 session entries and restores the latest structurally safe OpenPets record. Older or malformed records fall back to an idle companion with 80% energy, and the panel reports the total entries, scanned window, truncation, and whether restoration succeeded.

The optional `name` configuration defaults to `Pi`, must contain 1–128 characters, and rejects whitespace-only and NUL-containing values. A configured name always wins over a name in historical state. Energy remains an integer from 0 through 100, and interaction counts saturate at JavaScript's maximum safe integer.

`pet_react` accepts descriptor-safe parameters and four explicit actions:

```json
{ "action": "status" }
```

```json
{ "action": "feed" }
```

```json
{ "action": "play" }
```

```json
{ "action": "set_mood", "mood": "focused" }
```

`status` is read-only. `feed`, `play`, and `set_mood` increment the bounded interaction counter and append a private state entry. `mood` is required only for `set_mood` and must be `idle`, `focused`, `happy`, or `concerned`; ignored fields, accessors, unknown actions, invalid combinations, and already-cancelled calls are rejected before mutation.

Real `agent_start` events make the companion focused and reduce energy by five, `agent_end` makes it happy and restores five, and failed tool events make it concerned. Repeated consecutive failure events are deduplicated to avoid unnecessary session growth. Event-triggered persistence failures are isolated so they cannot unwind the Agent run; explicit tool actions still surface a failure to the caller. Because the upstream append API may throw after its durable commit point, OpenPets retains the attempted bounded state and reports saturated attempt/failure counts plus a 2,000-character error preview instead of claiming a rollback. Tool results, stored entries, backend panels, and browser views do not share mutable state objects.

### Session Bridge

Session Bridge moves a reviewable conversation handoff without editing the source session tree. `session_bridge_export` returns version 1 JSON for the active runtime manager. `session_bridge_preview` accepts that JSON or previews the current session directly and derives five bounded fields: goal, current state, key decisions, key files, and next step. The preview is a deterministic heuristic for review, not a trust or correctness verdict.

```json
{}
```

```json
{
  "package": "{\"version\":1,...}"
}
```

Each package is limited to 256 KiB, 100 retained messages, 16,000 characters per message, and 64,000 message characters in total. Export inspects at most 1,000 content parts per retained message before joining text. It keeps at most 100 unresolved image markers; image bytes are never embedded, and `hasImages` makes the loss explicit. Session IDs are limited to 256 characters, source working directories to 4,096, model provider and ID fields to 256 each, MIME types to 128, and attachment markers to 256. Export applies the byte limit to the final JSON representation as well as its logical fields, so control characters and lone surrogates cannot expand into a package that the importer rejects. Source and model metadata are read only from data properties; accessors are rejected without invocation.

The parser requires exact root, source, model, and message fields; a supported version; a strict ISO creation time; a message count matching the array; known roles; unique attachment markers; valid MIME types; and markers that point to existing image-bearing messages. Unknown fields, empty or NUL-containing source identifiers, partial models, inconsistent counts, oversized lists, and excess cumulative text are rejected rather than normalized silently. Tool parameters are descriptor-safe, reject unknown properties, and honor caller or plugin-shutdown cancellation before expensive work or target mutation.

Import is intentionally a separate, confirmed side effect because its visible custom message becomes part of the target LLM context. Preview and trust the package before calling:

```json
{
  "package": "{\"version\":1,...}",
  "confirm": true
}
```

Handoff text can contain instructions from another session and must be treated as untrusted input. `session_bridge_import` writes only to the currently active session manager and leaves the source untouched. It hashes the normalized package with SHA-256 and scans the newest 10,000 target entries, rejecting a duplicate before appending another context message. Panel previews are cached until a session event or manager replacement, backend reads return independent snapshots with explicit limits, and the browser applies its own fixed 1,000-character and eight-item preview caps. A separate operation status reports the latest export, preview, or import as running, completed, failed, or cancelled without replacing the last successful summary; error text is descriptor-safe and limited to 2,000 characters in both backend and browser views.

### Skill Guard

`skill_guard_scan` audits the entry Markdown files that Pi's resource loader has already accepted as Skills. It performs one scan during plugin startup and can rescan all loaded entries on demand:

```json
{}
```

An optional query of at most 120 characters filters returned reports by bounded Skill name or loader source after the complete bounded scan:

```json
{
  "query": "project"
}
```

Each scan considers at most 50 loaded entries and reads at most 128 KiB from each. Files must be regular, non-symbolic-link files containing strict UTF-8. Skill metadata is read only from data properties; malformed metadata, invalid UTF-8, oversized files, and read failures produce review findings without executing accessors or aborting the rest of the inventory. Names are limited to 64 characters, loader sources to 128, paths to 4,096, and each report has at most six fixed findings with a maximum score of 28. The backend panel retains no Skill source text, publishes at most 20 independent report snapshots, and exposes explicit scan-versus-display truncation. The browser reapplies the same fixed limits and renders at most eight report cards.

The detector uses bounded heuristics for common instruction-override phrases, credential exfiltration requests, remote `curl`/`wget` payloads, destructive commands, and decoding or dynamic-execution markers. A `blocked` result means “high-risk finding” in the audit API; Skill Guard does **not** remove, disable, rewrite, or prevent invocation of a Skill that Pi has already loaded. Pi's project trust gate remains the control that decides whether project-local resources may load. Heuristic scanning can produce both false positives and false negatives, so review the bounded file path and the original Skill before trusting or removing it.

Only the loaded entry Markdown is scanned. Referenced scripts, templates, images, and nested documentation are outside this plugin's scope and require separate review. Caller cancellation and plugin disposal are checked before and after each bounded read. A failed or cancelled rescan preserves the last completed report set while publishing a descriptor-safe status error of at most 2,000 characters.

### Recall Unread

`session_recall_unread` performs a read-only scan of native Pi JSONL sessions for the current workspace. It excludes the active session by both file path and session ID, then returns only sessions whose latest structurally valid message is a non-empty user message. A later assistant message means the session is answered and is not returned. The tool never appends, rewrites, deletes, opens, or resumes a session.

The plugin scans once during startup and caches the complete bounded unread inventory. Reading the plugin panel performs no filesystem work. Calling the tool explicitly starts a new scan; its optional query filters only that tool result and does not narrow the cached panel inventory:

```json
{}
```

```json
{
  "query": "release"
}
```

The query is descriptor-safe, rejects unknown properties, accessors, non-string and NUL-containing values, and is limited to 120 characters. Concurrent rescans are serialized in invocation order, and queued or active calls honor caller and plugin-shutdown cancellation. A completed, failed, or cancelled status is reported independently; a failed attempt keeps the last successful inventory, and status errors are limited to 2,000 characters without invoking error accessors.

Discovery uses `opendir` and examines at most 4,096 directory entries. It accepts regular `.jsonl` files only, excludes the active path before reading, sorts candidates by file modification time, and then reads at most `maxSessions`. The default is 100 and the configuration accepts integers from 1 through 500:

```yaml
- id: recall-unread
  name: "@pi-harness/core/plugins/recall-unread"
  config:
    maxSessions: 100
```

Each candidate is read from one `O_NOFOLLOW` file handle with a 4 MiB ceiling and fatal UTF-8 decoding, in batches of eight. Symbolic links, replaced or non-regular files, oversized files, invalid UTF-8, malformed headers, invalid IDs, cross-workspace sessions, and unreadable files are skipped. IDs and names are bounded to 256 characters; session and working-directory paths are bounded to 4,096. Message extraction inspects at most 1,000 content parts and retains a 500-character preview without invoking entry, message, or content getters.

One scan can retain at most 500 unread sessions. Tool details return at most 100 matches while preserving the full bounded match count; the backend panel returns at most 50, and the browser renders eight cards. Discovery, scan, result, and display truncation are explicit in inventory fields, and backend/tool/browser snapshots are independent so a consumer cannot mutate cached state.

### Turn Rewind

`session_rewind` moves the active native Pi session tree back to a user turn without deleting the abandoned branch. The default selector rewinds the latest user turn; `turns` accepts an integer from 1 through 20, including the first user turn when enough history exists:

```json
{
  "turns": 2
}
```

An exact entry ID shown by the Turn Rewind panel can be used instead:

```json
{
  "entryId": "01991f62-9eb4-7653-baa1-2b064e34d801"
}
```

Use either `turns` or `entryId`, never both. Entry IDs are trimmed, limited to 200 characters, and must not contain NUL. The tool rejects unknown properties, Symbols, accessors, non-plain parameter objects, fractional or out-of-range turn counts, and non-boolean `summarize` values before navigation.

Agent tools execute while a response is active, but Pi only permits tree navigation after that run is idle. Turn Rewind therefore returns an explicit `queued` result during the active run and performs the request only after Pi emits the authoritative `agent_settled` lifecycle event. A second queued or running request is rejected instead of replacing the first target or navigating concurrently. If the caller or plugin is cancelled before a queued request starts, the request is removed. If a caller stops waiting after native navigation begins, the underlying navigation continues and the panel retains its real state. A queued target is cancelled if resume, new, fork, or another operation replaces the session before it starts, so an entry ID from an old session is never applied to a new one.

Navigation uses Pi's UI-aware command context. In interactive mode this refreshes the rendered conversation and restores the selected user text to an empty editor; RPC and other modes use their native command behavior. The old branch remains in the append-only session tree and can be revisited. Set `summarize` only when a model-generated summary of the abandoned branch is desired:

```json
{
  "turns": 1,
  "summarize": true
}
```

Summarization may call the active model and incur cost. Pi extensions can cancel navigation, and an aborted or cancelled summary is reported as `cancelled`, not as a completed rewind.

Candidate discovery follows only the current leaf's parent chain; user messages on abandoned sibling branches are excluded. A scan examines at most 4,096 entries, inspects at most 1,000 content parts per user message without invoking entry, message, content, or array accessors, retains the newest 50 candidates, and limits each preview to 500 characters. Candidate IDs, editor text, and status errors are limited to 200, 4,096, and 2,000 characters respectively, with NUL replaced before publication.

The plugin scans once at startup and serves repeated panel reads from a cache. Explicit tool calls, settled runs, successful navigation, and active-session replacement refresh that cache. Operation state is published independently as `queued`, `running`, `completed`, `failed`, or `cancelled`, with request/start/finish timestamps and descriptor-safe bounded errors. Backend panel snapshots and tool details do not share mutable candidate or status objects, and the browser applies its own fixed limits before rendering the latest eight candidates.

### Context Doctor

`context_doctor` audits the active session without changing it by default. It reports validated context usage, message counts, messages that exceed the configured JSON byte threshold, messages that cannot be measured safely, and failed tool results:

```json
{}
```

The default warning threshold is 75%, and the default message threshold is 64 KiB. Both can be configured in the profile; `warnPercent` accepts 1–100 and `maxMessageBytes` accepts integer values from 1 KiB through 1 MiB:

```yaml
- id: context-doctor
  name: "@pi-harness/core/plugins/context-doctor"
  config:
    warnPercent: 75
    maxMessageBytes: 65536
```

Message measurement never calls getters, `toJSON`, proxy property reads, or value coercion. It reads data-property descriptors, reproduces JSON byte accounting for ordinary plain data, detects cycles and custom serialization, and fails closed for accessors or unsupported prototypes. One audit examines only the newest 10,000 messages, descends at most 64 levels, visits at most 10,000 values per message and 100,000 values across the entire audit, and marks work beyond those limits as uninspectable. Context usage fields and tool-error markers are also read without invoking accessors; if upstream usage estimation throws, message diagnostics remain available with unknown usage. A finite non-negative percentage remains valid above 100%, so genuine context overflow is still reported as a warning. Repeated panel polling uses a cached report; message, tool, agent, entry, and compaction lifecycle events refresh it, as do explicit audits and active-session replacement.

Manual compaction is a separate, explicit side effect and requires both flags:

```json
{
  "compact": true,
  "confirm": true
}
```

Compaction summarizes earlier history with the active model and may incur model usage and cost. Because an Agent tool call occurs during an active run, Context Doctor returns `queued` and waits for the authoritative `agent_settled` event before starting. An idle caller waits for completion. Only one queued or running compaction is allowed; a queued request is removed on caller or plugin cancellation and is cancelled if the active session changes before it starts. Active cancellation calls Pi's dedicated `abortCompaction()` API rather than aborting the Agent run. If cancellation arrives too late and upstream compaction still succeeds, the caller stops waiting while the panel records the real completed outcome.

The tool rejects unknown keys, Symbols, accessors, arrays, non-plain objects, non-boolean flags, and compaction without confirmation. Operation state is exposed as `idle`, `queued`, `running`, `completed`, `failed`, or `cancelled`, with request/start/finish timestamps and descriptor-safe errors limited to 2,000 characters. Tool results, cached reports, and panel snapshots use independent arrays and state objects. The browser revalidates every field, shows at most four 500-character recommendations, applies the same fixed structural ceilings, and never trusts backend-provided limits to raise its own caps.

### Runtime

The Runtime plugin is the lifecycle owner for Pi's active `AgentSession`; it intentionally exposes a service rather than an Agent tool. It combines the selected model, cwd-bound resources, session manager, built-in tools, and custom tools into one upstream `AgentSessionRuntime`. The default profile selects `thinkingLevel: medium`; accepted levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Runtime acquires an immutable tool-registry lease before construction. Requested tools must exist after Pi extensions finish their `session_start` handlers, allowing a trusted extension to register a declared tool during startup while failing activation if any configured tool remains missing. Extension tools that were discovered but omitted from the profile allowlist produce a diagnostic instead of disappearing silently.

One SessionManager can have only one runtime constructing or tearing down at a time. A lifecycle gate prevents HMR from creating a second AgentSession over the same JSONL transcript before the first session has aborted, emitted `session_shutdown`, and disposed. The gate and tool lease are released on every initial-creation and binding failure path as well as normal shutdown. Concurrent `dispose()` callers share the same teardown promise, so no caller can return early and accidentally release the gate while another teardown is still active.

New, resumed, forked, and imported sessions are rebound to Harness event forwarding. A failing `pi/session-event` listener is converted to a descriptor-safe diagnostic capped at 2,000 characters and cannot unwind into Pi's event dispatcher. Likewise, a failing `pi/extension-error` observer cannot turn an extension diagnostic into an Agent failure. Disposal first aborts an active run so pending tool results can be persisted, then lets upstream run the session shutdown hook before invalidating the session. Prompt calls after disposal fail explicitly.

### Context Insights

`context_inspect` is a read-only snapshot of the active model context. It accepts only an empty plain object and reports validated token usage, context-window percentage, message counts grouped by role, event totals, compaction starts, per-type event counts, and recent event timestamps. It never includes message bodies or tool arguments:

```json
{}
```

Message composition examines at most the newest 10,000 messages. Array elements, message roles, usage fields, and event types are read through data-property descriptors, so getters and proxy property reads are not executed; an inaccessible or unknown role is counted as `other`. If Pi cannot estimate context usage—for example because a malformed upstream message makes `getContextUsage()` throw—the usage fields become `null` while the bounded composition and lifecycle report remain available. Finite non-negative percentages above 100% are preserved as real overflow; only the visual progress bar is capped at its full width.

The backend retains at most 50 recent events and 64 event-type buckets, with event types limited to 128 characters and excess types aggregated as `other`. Panel polling serves an isolated cached snapshot instead of rescanning the session. Message, tool, Agent, entry, settled-run, and compaction completion events refresh that cache; an explicit tool call always refreshes it. When Pi replaces the active session through new, resume, fork, or import, the next event or read detects the new session, refreshes composition, and resets lifecycle counters so histories cannot leak across sessions.

Tool details, cached state, and panel reads do not share mutable composition or event objects. The browser revalidates all fields with fixed local ceilings, treats inconsistent composition as unknown, displays only the newest six events, sanitizes event types, and never trusts backend-provided counts or limits to increase its rendering work.

### Token Guard

Token Guard has no Agent tool; it observes Pi lifecycle events and asks the active runtime to abort when either configured budget is reached. The default profile enables a 90% context threshold and leaves the optional absolute run budget disabled:

```yaml
- id: token-guard
  name: "@pi-harness/core/plugins/token-guard"
  config:
    maxPercent: 90
    maxRunTokens: 0
```

`maxPercent` must be a number from 1 through 100. `maxRunTokens` must be an integer from 0 through 10,000,000; zero disables that budget. Unknown configuration keys, fractional run budgets, and out-of-range values fail startup instead of being silently clamped. Actual usage above 100% remains visible and always exceeds any valid configured percentage threshold.

The percentage guard reads Pi's active-context estimate. It inspects the first streaming message update and then at a fixed interval of 32 updates, while always inspecting authoritative message, turn, tool-completion, Agent, settled, entry, and compaction boundaries; high-volume tool progress events do not trigger redundant context scans. The absolute guard records cumulative billed session tokens at `agent_start` and compares later totals with that baseline. Pi persists finalized assistant and tool messages before later lifecycle events expose their billed usage, so the absolute guard stops the remaining run at the first event where the updated total is authoritative; it does not pretend to count unbilled streaming deltas.

Usage objects, nested statistics, event types, and errors are inspected without invoking data accessors. Missing or invalid telemetry is represented as unknown and surfaced through a bounded 2,000-character panel error instead of fabricating a threshold crossing or throwing from Pi's event dispatcher. Synchronous and asynchronous abort failures are contained and reported. Only one abort request is issued between `agent_start` boundaries even if usage oscillates around the threshold, and session replacement resets the baseline, counters, latch, and errors.

Panel reads serve cached scalar state and never re-run inspection or trigger another abort merely because the browser polls. The browser independently validates thresholds, token counts, derived exceeded state, and error text under fixed local limits before rendering.

### Failure Logger

Failure Logger has no Agent tool and never changes the active run. It listens for Pi extension-load/runtime errors, failed assistant turns, and context-compaction failures, then exposes the newest aggregate through its plugin panel. Matching source-and-message failures are deduplicated across intervening events: the record moves to the newest position, its timestamp is refreshed, and its occurrence counter increases. Counters saturate at JavaScript's largest safe integer instead of overflowing into imprecise values.

Agent failures are discovered by scanning backward for the newest assistant message whose `stopReason` is `error`, so trailing tool results or custom messages cannot hide the failure. One event examines at most the newest 10,000 messages. A missing or blank assistant error uses the stable `Agent turn failed` fallback. Compaction events with `aborted: true` are treated as cancellation rather than failure, even if an upstream implementation includes diagnostic text.

Event objects, message arrays, assistant fields, extension-error wrappers, and nested diagnostic values are read through own data-property descriptors. The logger does not invoke getters, proxy property reads, custom serialization, constructors, or value coercion. Cycles, accessors, unavailable proxies, BigInts, non-finite numbers, functions, and symbols receive bounded text representations. It retains at most 50 unique failures; complete messages are limited to 2,048 characters, extension paths to 512, nested strings to 512, object previews to 12 selected diagnostic fields or array entries, traversal to three levels and 64 values, and NUL characters are replaced before publication. Evictions and total observations remain visible separately from the retained-record count.

Every panel read returns detached failure objects. Plugin activation rollback and disposal remove both listeners and the panel. The browser treats panel JSON as untrusted input, reads only descriptors, inspects at most 50 entries, limits sources to 64 characters and messages to 2,048, bounds timestamp parsing, sanitizes NUL, validates counters and the fixed capacity, and reports when records or text were discarded or truncated.

### Stdio

Stdio is the default CLI application surface and intentionally exposes no Agent tool. It accepts exactly one prompt, streams only assistant text to stdout, and writes tool starts, failed tools, provider retries, resource warnings, and extension failures to stderr. Tool argument previews do not invoke getters or `toJSON`, tolerate cycles and hostile proxies, and are reduced to one 120-character line; tool names are limited to 128 characters. General diagnostic messages are limited to 2,048 characters, extension paths to 512, and NUL or line breaks cannot inject extra terminal records.

At startup Stdio reports at most 100 resource diagnostics and explicitly reports any omitted count. At completion it scans at most the newest 10,000 session messages for the authoritative final assistant result. Missing or unreadable final state, provider error or abort, model output truncation, and a run with no assistant text all exit non-zero instead of being reported as success. Shutdown cancels pending stdin and model work with exit code 130. Buffered writes are tracked through their completion callbacks, including asynchronous writes below Node's backpressure threshold, so normal exit does not rely on a `drain` event that may never occur; broken pipes remain contained and lifecycle disposal still runs.

### MCP Client

MCP Client connects only to local stdio servers started from an executable argv. Use `mcp_list_tools`, `mcp_list_resources`, and `mcp_list_prompts` with a `command` for a one-shot connection, or configure a stable server id and use `mcp_server_start`, `mcp_server_status`, and `mcp_server_stop` for a persistent connection. `mcp_call`, `mcp_read_resource`, and `mcp_get_prompt` accept either the same direct command or a running `serverId`.

```yaml
- id: mcp-client
  name: "@pi-harness/core/plugins/mcp-client"
  config:
    servers:
      - id: docs
        command: ["node", "./tools/docs-mcp.mjs"]
        autoStart: false
```

Commands contain at most 32 arguments of 4,096 UTF-8 bytes each. Shell wrappers such as `sh`, `bash`, `cmd`, and PowerShell are rejected on Unix and Windows, and no command string is interpolated. MCP processes are not sandboxes: they inherit the Pi Harness process permissions and can access anything that executable can access, so configure only trusted local servers and never place secrets directly in command arguments.

The client validates the `2025-06-18` initialize handshake, JSON-RPC envelopes, UTF-8 framing, tool/resource/prompt descriptors, and Agent-facing text or image content. Each request has a 30-second timeout and a 1 MiB cumulative response limit; tool and prompt argument objects are descriptor-safe, limited to 64 KiB and 32 nesting levels, and never execute getters during validation. Tool, resource, and prompt discovery follows MCP pagination while rejecting repeated or malformed cursors, with at most 100 pages and 1,000 accumulated items. Configured and concurrently managed servers are capped at 128, server stderr at an 8 KiB byte tail, and the backend panel at 20 items per inventory. The browser applies smaller 12-tool/server and 8-resource/prompt previews.

Caller cancellation works both while a request is active and while it waits behind another request on a persistent server. Plugin shutdown cancels one-shot and managed requests, closes stdin, sends `SIGTERM`, and escalates to `SIGKILL` when a child does not exit. Text resources and prompt messages are converted to Agent text content, images remain images, and unsupported binary or audio content—including resources without an optional MIME type—is represented by a bounded omission marker rather than being passed through as an invalid Agent payload.

## Author a plugin

[`examples/plugin-hello`](./examples/plugin-hello) is a complete external Cordis plugin. It contributes a native Pi `ToolDefinition`, registers cleanup with `ctx.effect()`, and provides a readiness marker after registration:

```ts
export default {
  name: "pi-hello",
  inject: ["piTools"],
  apply(ctx: Context) {
    ctx.effect(() => ctx.piTools.register(helloTool));
    ctx.provide("piHelloTool", helloTool);
  },
};
```

Custom tools are a startup contract. The runtime leases an immutable tool snapshot while its Pi session exists, so a profile must make runtime activation depend on every tool plugin's marker:

```yaml
- id: tools
  name: "@pi-harness/core/plugins/tools"
  config:
    names: [read, bash, edit, write]
- id: hello
  name: "@pi-harness/plugin-hello"
  config: {}
- id: runtime
  name: "@pi-harness/core/plugins/runtime"
  inject:
    - piHelloTool
  config:
    thinkingLevel: medium
```

This uses Cordis injection for deterministic ordering. A late contribution fails startup instead of being silently omitted from the active AgentSession. When HMR unloads a tool marker, Cordis first disposes the dependent runtime and releases its snapshot; the reloaded tool plugin can then register against the same lifecycle-owned registry.

## Failure and security boundaries

- A profile can load arbitrary Node.js modules. Treat profile files and plugin packages as executable code.
- Project-local Pi resources under the invocation directory's `.pi/` — extensions, settings, and system-prompt overrides — are executable code owned by whoever wrote the repository. They are loaded only when the project is trusted: a decision recorded by Pi's own trust store for that directory, or `trustProject: true` on the `pi-resources` entry. An untrusted project is reported on stderr and its resources are skipped, so `cd`-ing into a cloned repository and running `pih` does not execute its extensions.
- Extensions under `PI_AGENT_DIR` are user-owned and always load. `session_shutdown` runs before the Pi session is disposed, so an extension's session-scoped resources are released on every exit path.
- A plugin cannot register a tool whose name belongs to a Pi built-in (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`); the collision fails startup instead of silently replacing the built-in in the model's tool table.
- Missing modules, invalid configuration, unresolved injections, model lookup failures, and plugin activation failures abort startup and dispose the partial tree. Configuration validation rejects unknown keys, so a mistyped `name:` in place of `names:` fails startup instead of silently restoring a default toolset.
- The runtime does not fall back to a different model or storage backend. A Pi extension that fails to load aborts startup instead of leaving the agent with a silently reduced tool set.
- The bundled stdio application writes only assistant text to stdout and bounded, single-line operational diagnostics to stderr. Missing or unreadable final state, provider failure or abort, output truncation, and a run with no assistant text exit non-zero.
- A closed stdout (`pih ... | head`) stops output without killing the process, so the Cordis tree is still disposed.
- Provider traffic goes through the proxy `HTTP_PROXY`, `HTTPS_PROXY` or the `httpProxy` setting names, using Pi's own dispatcher so the harness and `pi` behave identically on a proxied network.
- An application surface receives an `AbortSignal` and shares the shutdown deadline: one that ignores the signal is force-exited rather than keeping the process alive. Buffered output is flushed before a forced exit, except on a repeated signal, which leaves immediately.
- Tools an extension registers but the profile does not list are reported on stderr instead of disappearing from the model's tool table.
- Signals cancel startup or abort the active Pi run before the Cordis tree is disposed. Runtime abort and root disposal have a five-second deadline, after which the executable forces the signal-compatible exit code. A repeated signal during that window forces the exit immediately. A pending prompt read is cancelled too, so a signal never leaves the process alive holding an open stdin pipe, and cancelling the interactive prompt with Ctrl-C exits 130 rather than the usage code 2.
- The production profile excludes HMR. Development HMR grants access to Node internal ESM loader APIs only in the relaunched development process.
- Existing Pi resources and extensions under `PI_AGENT_DIR` participate in startup and shutdown. Use an isolated agent directory for deterministic tests.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

`npm test` builds every workspace before running Vitest, so Loader integration tests resolve the same package exports shipped to users. Tests use real Cordis contexts and real Pi sessions; deterministic provider fixtures avoid paid network requests.

## Release

Publishing is triggered by a push to `main` (including a merged pull request), or manually with `workflow_dispatch`. The `Release packages` workflow runs the complete test, lint, and diff gate, publishes the user-facing `@pi-harness/pi-harness` package and the independently installable `@pi-harness/core` package, skips package versions that already exist, and creates a matching GitHub Release tag. Users normally install only `@pi-harness/pi-harness`; its `@pi-harness/core` dependency is intentionally not bundled, so core plugins can receive a compatible patch release without republishing the launcher. The web app and remaining implementation workspaces are private and are never published.

Before the first release, add the npm automation token as the GitHub Actions secret `NPM_TOKEN`. The workflow passes the secret through `NODE_AUTH_TOKEN` and publishes to npm without provenance because this repository is private and npm rejects provenance attestations from private GitHub sources. The token must be allowed to publish both package names and, if npm two-factor authentication is enabled, use an automation-compatible publish policy. A bug fix in a built-in plugin should be released as a new compatible `@pi-harness/core` patch version; a launcher release is only needed when launcher, web, or API behavior changes. The release workflow keeps the repository's coordinated version metadata and publishes both artifacts for normal releases, while the standalone core package can also be published independently when a plugin-only hotfix is required.

For a plugin-only hotfix, bump `packages/core/package.json`, run `npm run build -w @pi-harness/core`, and publish that workspace with `npm publish --workspace @pi-harness/core --access public`. The launcher accepts any compatible `0.1.x` core release through its caret dependency, so users can update `@pi-harness/core` without reinstalling the launcher.

## Workspace layout

- `packages/core`: Cordis boot host, typed Pi services, runtime plugins, and built-in profiles
- `packages/cli`: launcher argument, process, stdio, signal, and development re-exec handling
- `packages/host-webserver`: Cordis-owned HTTP server and route lifecycle
- `packages/api-gateway`: Cordis API plugin for status, live sessions, model selection, workspace files, prompts, abort, and SSE events
- `packages/client-web`: browser-side Cordis plugin tree and console surface
- `packages/bundle-web-app`: static frontend and SPA fallback plugin
- `apps/web`: Vite entrypoint and production web launcher
- `examples/plugin-hello`: lifecycle-safe external Pi tool plugin
- `docs/plans`: accepted architecture and implementation plan

## License

MIT. See [LICENSE](./LICENSE).
