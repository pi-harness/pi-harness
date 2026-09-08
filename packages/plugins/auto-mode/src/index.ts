import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

const execFileAsync = promisify(execFile);
const maxArgs = 32;
const maxArgBytes = 4096;
const maxOutputBytes = 128 * 1024;
const defaultTimeoutMs = 30_000;
const shellWrappers = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "env",
  "sudo",
  "su",
  "nice",
  "nohup",
  "time",
  "timeout",
  "stdbuf",
  "xargs",
]);
const safeCommands = new Set([
  "basename",
  "cat",
  "cmp",
  "diff",
  "dirname",
  "echo",
  "grep",
  "head",
  "id",
  "ls",
  "printf",
  "pwd",
  "stat",
  "tail",
  "uname",
  "wc",
  "which",
  "whoami",
]);
const safeFileOptions = new Set([
  "-b",
  "--brief",
  "-i",
  "-I",
  "--mime",
  "--mime-type",
  "--mime-encoding",
  "--extension",
  "-h",
  "--no-dereference",
  "-L",
  "--dereference",
  "-k",
  "--keep-going",
  "-n",
  "--no-buffer",
  "-N",
  "--no-pad",
  "-0",
  "--print0",
  "-r",
  "--raw",
  "-v",
  "--version",
  "--help",
]);
const safeGitSubcommands = new Set(["blame", "cat-file", "describe", "diff", "grep", "log", "ls-files", "ls-tree", "rev-parse", "show", "status"]);
// A read-only git subcommand runs a program by two independent routes, and screening argv only closes the first one.
// Option-borne execution: the argv itself names the program, as in `git grep -O./payload.sh` or `git diff --output=victim`. git's parse-options accepts stacked short options (-iO<prog>) and any unambiguous long-option prefix (--open-files-in-pag=<prog>), so a denylist of canonical spellings can always be respelled around; options are therefore allowlisted by exact spelling. An allowlisted spelling is not safe on its own either, because git resolves an exact match first only when the spelling is a registered option of the subcommand in use and otherwise resolves it as a prefix of some other option - `--text` (no such option under cat-file) reaches `--textconv`. Every long option is therefore also rejected when it is a prefix of a programRunningGitOptions entry, whichever allowlist it appears on.
// Repository-borne execution: the argv names nothing at all and the repository's own configuration supplies the program. `diff.<driver>.textconv` plus a `.gitattributes` entry makes plain `git show HEAD`, `git diff`, `git log -p` and `git blame file` execute it, and `filter.<driver>.clean` makes plain `git status` and `git ls-files --modified` execute it. No argv screening can see this, so before every unconfirmed git command the effective configuration is probed for program-executing keys and the command is treated as risky when any are set.
// Both checks are required: the argv screen closes commands the configuration would not run, and the configuration probe closes commands whose argv is unremarkable.
const programRunningGitOptions = [
  "--exec",
  "--exec-path",
  "--ext-diff",
  "--filters",
  "--open-files-in-pager",
  "--output",
  "--receive-pack",
  "--textconv",
  "--upload-pack",
];
const safeGitOptions = new Set([
  "-c",
  "-e",
  "-i",
  "-l",
  "-n",
  "-p",
  "-q",
  "-r",
  "-s",
  "-t",
  "-u",
  "-v",
  "-w",
  "-z",
  "-E",
  "-F",
  "-I",
  "-L",
  "-M",
  "-P",
  "-R",
  "-S",
  "-U",
  "-W",
  "--abbrev-commit",
  "--all",
  "--all-match",
  "--basic-regexp",
  "--branch",
  "--cached",
  "--count",
  "--date-order",
  "--decorate",
  "--deleted",
  "--exclude-standard",
  "--extended-regexp",
  "--files-with-matches",
  "--files-without-match",
  "--first-parent",
  "--fixed-strings",
  "--full-history",
  "--full-name",
  "--graph",
  "--heading",
  "--ignore-all-space",
  "--ignore-case",
  "--ignore-space-change",
  "--invert-match",
  "--line-number",
  "--long",
  "--merges",
  "--modified",
  "--name-only",
  "--name-status",
  "--no-color",
  "--no-decorate",
  "--no-merges",
  "--no-patch",
  "--no-renames",
  "--numstat",
  "--oneline",
  "--only-matching",
  "--others",
  "--patch",
  "--perl-regexp",
  "--porcelain",
  "--quiet",
  "--raw",
  "--relative",
  "--reverse",
  "--short",
  "--shortstat",
  "--stage",
  "--staged",
  "--stat",
  "--summary",
  "--topo-order",
  "--untracked",
  "--verbose",
  "--version",
  "--word-diff",
  "--word-regexp",
]);
const safeGitValueOptions = new Set([
  "--abbrev",
  "--after",
  "--author",
  "--before",
  "--color",
  "--committer",
  "--date",
  "--diff-filter",
  "--format",
  "--grep",
  "--max-count",
  "--max-depth",
  "--pretty",
  "--since",
  "--unified",
  "--until",
]);
// Digits are the only suffix accepted for the counted short options: git reads the rest of a cluster as further short options, and no digit option runs a program or writes a file.
const numericShortGitOption = /^-[ABCMUn][0-9]+$/u;
// Configuration keys whose value is a program git may execute, limited to the ones an allowlisted read-only subcommand was measured to reach on git 2.50.1. core.fsmonitor covers status, diff and ls-files; diff.external, diff.<driver>.command and diff.<driver>.textconv cover blame, diff, log, show, grep and cat-file; filter.<driver>.clean, .smudge and .process cover status, diff, ls-files and grep; gpg.program and gpg.<format>.program cover log and show, because a %G placeholder in --format or --pretty forces signature verification of a commit whose object carries a gpgsig header and that spawns the configured gpg program; core.hooksPath covers status, which refreshes and rewrites the index and so runs <hooksPath>/post-index-change.
// core.sshCommand, sequence.editor and uploadpack.packObjectsHook were removed from this list after a payload planted in each of them was not executed by any of blame, cat-file, describe, diff, grep, log, ls-files, ls-tree, rev-parse, show or status. The same sweep found nothing executed through core.editor, core.pager, pager.<cmd>, core.askPass, core.gitProxy, core.alternateRefsCommand, credential.helper, diff.guitool, difftool.<tool>.cmd, merge.<driver>.driver, mergetool.<tool>.cmd, trailer.<token>.command, remote.<name>.uploadpack or ssh.variant either.
// core.hooksPath was tried the same way and kept, because a hook directory holding an executable post-index-change did run it from `git status` and `git status --short`. It is the one key that does not make every subcommand risky: with all 28 hook names githooks(5) documents planted in the directory as executables, the only ones that ran were post-index-change from those two invocations, and nothing at all ran from blame, cat-file, describe, diff, diff HEAD, grep, log, log -p, ls-files, ls-files --modified, ls-tree, rev-parse or show. It is therefore treated as risky only for the subcommands that read the worktree or refresh the index, which keeps `git log`, `git show` and `git rev-parse` working in the husky repositories that set it - a guard that blocks every command in a repository laid out the way most JavaScript repositories are laid out gets switched off, and then nothing is guarded. The set is deliberately wider than the measurement: blame, grep, diff and ls-files rewrite the index for the same stat-refresh reason status does, so they keep asking even though a hook was only observed to run from status, and from diff on some runs but not others.
// Screening this key is not by itself a guard against the hook route, and reading it as one would be a mistake: core.hooksPath moves a directory git uses in either case, so an executable .git/hooks/post-index-change reaches the same program execution in a repository whose configuration is empty. runsIndexChangeHook is what covers that, for the same subcommand set and by resolving the effective directory rather than the key.
// Only the repository's own scopes count. --show-scope labels every entry, and system, global and command scope describe the machine the agent is running on - the user's ~/.gitconfig, /etc/gitconfig, and this probe's own -c arguments - rather than the untrusted repository this probe exists for, so a machine-wide git-lfs filter no longer makes every command in every clean repository risky. Every other scope, including local, worktree and any scope name this code does not recognise, is treated as repository-controlled. `include.path` and `includeIf` inside .git/config are reported as local scope, so an include cannot launder a hostile key into global scope.
// `git help config` also documents core.pager and pager.<cmd>, credential.helper, core.editor, merge.<driver>.driver, mergetool.<tool>.cmd, difftool.<tool>.cmd and diff.guitool as program-executing. The pager keys have a second reason to be excluded: git only starts a pager when stdout is a terminal and auto mode always runs commands through execFile with a pipe - a core.pager pointing at a script runs under `script -q /dev/null git log` and does not run under execFile - and the top-level -p and --paginate spellings that would force one are rejected before this point as unknown subcommands. The measurement behind all of these is one payload per key and 19 invocations covering every allowlisted subcommand; a route that needs a repository state the sweep did not create would not have shown up in it. alias.* is excluded because git never resolves an alias whose name is a built-in command, and every allowlisted subcommand is built in.
// git lowercases the section and key parts of a name but not the subsection, so the pattern is written in lower case with `.*` spanning subsections; it is anchored to full key names and matched by git itself, not in this process.
const programExecutingGitConfigPattern =
  "^(core\\.(fsmonitor|hookspath)|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|process|smudge)|gpg\\.(.*\\.)?program)$";
const machineOwnedGitConfigScopes = new Set(["system", "global", "command"]);
// git reports this key already lower-cased, because it has no subsection; the comparison lower-cases anyway so that the narrowing cannot be missed by a spelling git chose to report differently.
const hooksPathGitConfigKey = "core.hookspath";
const worktreeReadingGitSubcommands = new Set(["blame", "diff", "grep", "ls-files", "status"]);
// The probe must not act on the configuration it is reading: --no-pager and -c core.pager=cat keep it from spawning a pager, -c core.fsmonitor=false keeps it from starting a monitor process, and `config --get-regexp` only reads. git reports its own command-line -c settings as part of the effective configuration, so core.fsmonitor comes back as a match, labelled `command` scope and therefore not repository-controlled. -z is what makes the output parseable: without it a configured value containing a newline splits into further lines that look like entries of their own, while with it git emits a NUL-terminated scope record followed by a NUL-terminated `key\nvalue` record for every match, and a configuration value can never contain a NUL.
const gitConfigProbeArgv = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "config",
  "-z",
  "--show-scope",
  "--get-regexp",
  programExecutingGitConfigPattern,
];
// A submodule carries a configuration file the probe above cannot see. `git config filter.evil.clean <payload>` written into .git/modules/sub/config, with `sub/.gitattributes` naming that filter, makes a plain `git status` in the superproject execute it while the superproject's own configuration is empty. Walking every submodule's configuration is its own bug surface, so the presence of any submodule instead makes every unconfirmed git command risky; a submodule in an agent workspace is rare enough that the confirmation costs little.
// The signal is a gitlink - index mode 160000 - because that entry is what makes git descend into the directory. The other candidate signals are both evadable: a `.gitmodules` file is gone once it is deleted from the worktree, and `.git/modules` does not exist when the submodule is an embedded repository staged with a plain `git add`, yet `git status` was measured to run the payload in both of those layouts. --abbrev=4 shortens the object name that is never read, and -z makes the record boundary a NUL so that a path containing a newline cannot forge one.
// The `:/` pathspec is load-bearing: `git ls-files` lists only the part of the index under the current directory, while `git status` and `git diff` cover the whole repository from anywhere inside it, so without a top-level pathspec a submodule beside the agent's working directory - workspace/src as the working directory, workspace/sub as the submodule - was measured to leave the index probe seeing no gitlink at all while `git status` still ran the submodule's filter.
const gitIndexProbeArgv = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "ls-files", "--stage", "--abbrev=4", "-z", "--", ":/"];
const gitlinkIndexPrefix = "160000 ";
// core.hooksPath only relocates a directory git runs hooks out of whether or not the key is set, so screening the key alone leaves the default location unscreened: a repository carrying an executable .git/hooks/post-index-change and no configuration at all was measured running it from `git status` and `git status --short`, with the configuration probe reporting nothing but its own command-scope core.fsmonitor. `git rev-parse --git-path` resolves the effective location for either layout, so this probe covers the relocated directory too and does not depend on the key having been seen. Only post-index-change is looked for, and only for the subcommands that read the worktree: with all 28 hook names githooks(5) documents planted as executables, it was the only hook any allowlisted subcommand ran, and looking for the rest would make every repository holding an ordinary pre-commit hook ask for confirmation.
const gitHookPathProbeArgv = ["--no-pager", "rev-parse", "--git-path", "hooks/post-index-change"];
// The index listing is one short record per tracked file, so it needs a larger ceiling than a command's output; a repository too large for this fails closed rather than going unchecked.
const maxIndexBytes = 16 * 1024 * 1024;
// Belt and braces on top of the configuration probe, for the window between the probe and the execution: these subcommands are the ones that consult textconv and external diff drivers. Each flag was checked against git 2.50 by running it - `git grep --no-ext-diff` is rejected as an unknown option, so grep gets only --no-textconv, and the subcommands outside this map (cat-file, describe, ls-files, ls-tree, status) reject both flags and get neither.
const diffDriverFreeGitFlags = new Map([
  ["blame", ["--no-textconv", "--no-ext-diff"]],
  ["diff", ["--no-textconv", "--no-ext-diff"]],
  ["grep", ["--no-textconv"]],
  ["log", ["--no-textconv", "--no-ext-diff"]],
  ["show", ["--no-textconv", "--no-ext-diff"]],
]);
type AutoModeResult = { command: string[]; allowed: boolean; confirmed: boolean; exitCode: number | null; stdout: string; stderr: string; durationMs: number };

export interface AutoModePluginConfig {
  mode?: "safe" | "confirm";
  timeoutMs?: number;
}
export const Config: z<AutoModePluginConfig> = z.object({
  mode: z.union(["safe", "confirm"]).default("safe"),
  timeoutMs: z.number().default(defaultTimeoutMs),
});

function commandName(value: string): string {
  return value
    .split(/[\\/]/u)
    .at(-1)!
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/u, "");
}

function validateCommand(command: unknown): asserts command is string[] {
  if (!Array.isArray(command)) throw new Error("Auto mode command must be an array");
  const parts: unknown[] = command;
  if (parts.length === 0 || parts.length > maxArgs) throw new Error(`Auto mode command must contain between 1 and ${maxArgs} arguments`);
  if (!parts.every((part): part is string => typeof part === "string")) throw new Error("Auto mode command arguments must be strings");
  if (parts.some((part) => part.length === 0 || Buffer.byteLength(part, "utf8") > maxArgBytes))
    throw new Error("Auto mode command contains an invalid argument");
  if (shellWrappers.has(commandName(parts[0] ?? ""))) throw new Error("Auto mode rejects shell wrappers; pass an executable argv directly");
}

function resolvesToProgramRunningGitOption(name: string): boolean {
  return name.startsWith("--") && name.length > 2 && programRunningGitOptions.some((option) => option.startsWith(name));
}

function hasUnsafeGitArgument(argumentList: readonly string[]): boolean {
  let pathspecOnly = false;
  for (const argument of argumentList) {
    if (pathspecOnly) continue;
    if (argument === "--") {
      pathspecOnly = true;
      continue;
    }
    if (!argument.startsWith("-")) continue;
    const separator = argument.indexOf("=");
    const name = separator > 0 ? argument.slice(0, separator) : argument;
    if (resolvesToProgramRunningGitOption(name)) return true;
    if (safeGitOptions.has(argument) || numericShortGitOption.test(argument)) continue;
    if (separator > 0 && safeGitValueOptions.has(name)) continue;
    return true;
  }
  return false;
}

// The answer is never cached: a repository can gain a hostile configuration between two calls, and two short git reads per unconfirmed git command are cheap next to the command they guard.
async function configuresProgramExecution(subcommand: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  let stdout: string;
  try {
    stdout = (await execFileAsync("git", gitConfigProbeArgv, { cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes, signal })).stdout;
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string };
    // Status 1 with no output is git reporting that no key matched. Every other failure - git missing, unreadable configuration, timeout, aborted, output over the buffer limit - leaves the configuration unknown and fails closed.
    return failure.code !== 1 || (failure.stdout ?? "") !== "";
  }
  // Under -z the records alternate scope, `key\nvalue`, scope, `key\nvalue`, so each entry is a pair and the trailing empty record after the final NUL has no partner and is skipped by the bound. A value may contain newlines, which is why only the part of the second record before the first newline is the key.
  const records = stdout.split("\0");
  for (let offset = 0; offset + 1 < records.length; offset += 2) {
    const scope = records[offset]!;
    if (scope.length === 0 || machineOwnedGitConfigScopes.has(scope)) continue;
    const key = records[offset + 1]!.split("\n", 1)[0]!.toLowerCase();
    if (key === hooksPathGitConfigKey && !worktreeReadingGitSubcommands.has(subcommand)) continue;
    return true;
  }
  return false;
}

async function runsIndexChangeHook(cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  let stdout: string;
  try {
    stdout = (await execFileAsync("git", gitHookPathProbeArgv, { cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes, signal })).stdout;
  } catch {
    // `git rev-parse --git-path` only fails when there is no repository, and a directory that is not one runs no hook.
    return false;
  }
  // git prints the path relative to the current directory unless the repository was found somewhere else, so it is resolved against the same cwd the command would run in.
  const path = stdout.split("\n", 1)[0]!.trim();
  if (path === "") return false;
  const info = await stat(resolve(cwd, path)).catch((error: NodeJS.ErrnoException) => error.code ?? "unknown");
  // Missing is the ordinary case and means no hook. Anything else that is not a stat result - a permission error, a broken link, a path that is not there any more - leaves the answer unknown and fails closed.
  if (typeof info === "string") return info !== "ENOENT" && info !== "ENOTDIR";
  return info.isFile() && (info.mode & 0o111) !== 0;
}

async function containsSubmodule(cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  let stdout: string;
  try {
    stdout = (await execFileAsync("git", gitIndexProbeArgv, { cwd, timeout: timeoutMs, maxBuffer: maxIndexBytes, signal })).stdout;
  } catch {
    // `git ls-files` needs a repository, and a directory that is not one holds no submodule, so a failure is only treated as unknown once git confirms a repository is there. Anything else - an unreadable index, a timeout, an abort, an index too large for the buffer - fails closed.
    try {
      await execFileAsync("git", ["--no-pager", "rev-parse", "--git-dir"], { cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes, signal });
    } catch {
      return false;
    }
    return true;
  }
  return stdout.split("\0").some((record) => record.startsWith(gitlinkIndexPrefix));
}

async function isRisky(command: string[], repositoryProbe: (subcommand: string) => Promise<boolean>): Promise<boolean> {
  if (/[\\/]/u.test(command[0] ?? "")) return true;
  const executable = commandName(command[0] ?? "");
  if (executable === "file") {
    // file can compile magic databases and launch external decompressors, so only known inspection options run without confirmation.
    for (const argument of command.slice(1)) {
      if (argument === "--") break;
      if (argument.startsWith("-") && argument !== "-" && !safeFileOptions.has(argument)) return true;
    }
    return false;
  }
  if (safeCommands.has(executable)) return false;
  if (executable !== "git") return true;
  const subcommand = command[1]?.toLowerCase() ?? "";
  const reportsVersion = subcommand === "--version" || subcommand === "version";
  if (!reportsVersion && !safeGitSubcommands.has(subcommand)) return true;
  // Read-only git subcommands still accept options that run a program (grep -O) or overwrite a path (--output), so every remaining option is screened against the allowlist.
  if (hasUnsafeGitArgument(command.slice(2))) return true;
  // `git --version` and `git version` print a string compiled into the binary. They open no repository, so no repository configuration can act on them and probing one would only block the command in repositories that are merely unusual.
  if (reportsVersion) return false;
  // The argv is clean, so the remaining question is whether the repository itself turns this subcommand into program execution. The subcommand is known to be one of the allowlisted names by now, and the probe needs it because one probed key - core.hooksPath - was measured to be reachable from some of them and not from others.
  return await repositoryProbe(subcommand);
}

function withDiffDriverFreeGitFlags(command: string[]): string[] {
  if (commandName(command[0] ?? "") !== "git") return command;
  const flags = diffDriverFreeGitFlags.get(command[1]?.toLowerCase() ?? "");
  if (flags === undefined) return command;
  return [command[0]!, command[1]!, ...flags, ...command.slice(2)];
}

export default {
  name: "pi-auto-mode",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: AutoModePluginConfig) {
    const mode = config.mode === "confirm" ? "confirm" : "safe";
    const configuredTimeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    const timeoutMs = Number.isFinite(configuredTimeoutMs) ? Math.max(1_000, Math.min(120_000, Math.trunc(configuredTimeoutMs))) : defaultTimeoutMs;
    const lifecycle = new AbortController();
    let blocked = 0;
    let last: AutoModeResult | undefined;
    const execute = async (command: string[], confirm: boolean, signal?: AbortSignal): Promise<AutoModeResult> => {
      signal?.throwIfAborted();
      try {
        validateCommand(command);
      } catch (error) {
        blocked += 1;
        throw error;
      }
      const requested = [...command];
      if (!confirm) {
        const risky = await isRisky(
          requested,
          async (subcommand) =>
            (await configuresProgramExecution(subcommand, context.piHarnessLaunch.cwd, timeoutMs, signal)) ||
            (worktreeReadingGitSubcommands.has(subcommand) && (await runsIndexChangeHook(context.piHarnessLaunch.cwd, timeoutMs, signal))) ||
            (await containsSubmodule(context.piHarnessLaunch.cwd, timeoutMs, signal)),
        );
        signal?.throwIfAborted();
        if (risky) {
          blocked += 1;
          throw new Error("Auto mode blocked a risky command; retry with confirm=true");
        }
      }
      if (mode === "confirm" && !confirm) {
        blocked += 1;
        throw new Error("Auto mode is configured for confirmation; retry with confirm=true");
      }
      // An unconfirmed git command is additionally run with the repository's textconv and external diff drivers switched off, which narrows the window between the probe and this call. It does not close it: a content filter added in that window still runs, because git has to apply filter.<driver>.clean to compare the worktree with the index and no option turns that off. The probe is what closes the class; these flags only remove the diff-driver route.
      const argv = confirm ? requested : withDiffDriverFreeGitFlags(requested);
      const started = Date.now();
      try {
        const result = await execFileAsync(argv[0]!, argv.slice(1), {
          cwd: context.piHarnessLaunch.cwd,
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          signal,
        });
        last = {
          command: argv,
          allowed: true,
          confirmed: confirm,
          exitCode: 0,
          stdout: result.stdout.slice(-maxOutputBytes),
          stderr: result.stderr.slice(-maxOutputBytes),
          durationMs: Date.now() - started,
        };
      } catch (error) {
        signal?.throwIfAborted();
        const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        last = {
          command: argv,
          allowed: true,
          confirmed: confirm,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: (failure.stdout ?? "").slice(-maxOutputBytes),
          stderr: (failure.stderr ?? failure.message ?? "").slice(-maxOutputBytes),
          durationMs: Date.now() - started,
        };
      }
      return last;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "auto_mode_exec",
        label: "Auto mode exec",
        description: "Execute an argv command under the configured safe/confirmation policy without a shell.",
        promptSnippet: "run a command through the safe auto-mode policy",
        parameters: Type.Object(
          {
            command: Type.Array(Type.String({ minLength: 1, maxLength: maxArgBytes }), { minItems: 1, maxItems: maxArgs }),
            confirm: Type.Optional(Type.Boolean({ description: "Confirm a risky or confirmation-mode command" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<AutoModeResult>> {
          const executionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const result = await execute(params.command, params.confirm === true, executionSignal);
          return {
            content: [{ type: "text", text: `${result.command.join(" ")} exited with ${result.exitCode ?? "unknown"}.\n${result.stdout}${result.stderr}` }],
            details: structuredClone(result),
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "auto-mode-panel",
      pluginId: "@pi-harness/plugin-auto-mode",
      title: "Auto Mode",
      description: "按安全策略执行 argv 命令，风险操作需要确认。",
      icon: "◈",
      read: () => ({ mode, timeoutMs, blocked, last: last === undefined ? null : structuredClone(last) }),
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("Auto mode plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
