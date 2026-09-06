import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { readBoundedFile } from "../bounded-file.js";
import { resolveExistingWorkspacePath } from "../workspace-path.js";
import { EmptyConfig } from "../config.js";

const maxFiles = 500;
const maxFileBytes = 512 * 1024;
const maxDirectories = 512;
const maxDepth = 16;
const ignoredDirectories = new Set([".git", ".pi", "node_modules", "dist", "build", "coverage"]);

export type AuditSeverity = "critical" | "high" | "medium";
export type AuditFindingKind = "credential" | "private-key" | "shell-pipeline" | "destructive-command";

export interface AuditFinding {
  path: string;
  line: number;
  severity: AuditSeverity;
  kind: AuditFindingKind;
  message: string;
}

export interface AuditSummary {
  root: string;
  scanned: number;
  skipped: number;
  total: number;
  critical: number;
  high: number;
  medium: number;
  changed: boolean;
  findings: AuditFinding[];
}

const credentialPattern = /\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,})\b/iu;
const privateKeyPattern = /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP )?PRIVATE KEY-----/u;
// A credential assignment is recognised by walking the line to each `:` or `=` and looking at a bounded window on either side, never by one regex spanning the whole line. The earlier single-regex form put the credential word inside two stars made of the same characters, so a line of repeated `token_` had quadratically many split points and a 512 KB line cost about 74 seconds. Here the key window is capped at maxCredentialKeyLength and the value window at maxCredentialValueLength, so the work at one separator is constant and cannot compound with the work at the next. The per-line cap is a second, cruder line of defence: 4096 characters is far above any hand-written config or source line that could carry a credential and far below a minified bundle line, so a line over that is skipped outright rather than trusted to the scan above.
// The key side is matched loosely (any case, any quoting, any prefix or suffix) and the decision is made on the value side, because that is what separates a leaked credential from ordinary source. A credential value is a literal: a quoted string, or an unquoted run that stops at the punctuation of code, so calls, member expressions and generic type arguments never produce a value at all. Three literals are excluded on top of that: a mixed-case alphabetic word is a camelCase or PascalCase symbol name rather than a secret, an all-digit run is a numeric constant such as a token budget, and a version range under a quoted package-name key is a dependency specifier from a lockfile. A password key whose value is a mixed-case alphabetic word such as SuperSecretPass is therefore missed; that is the price of not reporting every TypeScript type annotation.
const maxCredentialLineLength = 4096;
const maxCredentialKeyLength = 64;
// What makes the value scan linear is the memoisation, not this bound. The earlier form was one sticky `{8,}` run whose character class excluded every character its trailing lookahead accepted, so a value that never terminated cleanly walked the whole rest of the line before failing and the loop repeated that at the next separator - a line of repeated `token:` cost about 580 ms for a 512 KB file of such lines and 12.9 seconds for twenty of them through auditWorkspace. The bare run is now located by one forward search for the first stop character, memoised across separators: that position is monotonically non-decreasing as the separator moves right, so the scan visits each character of the line once no matter how many separators there are.
// The bound only decides how long a run may be and still count as a credential. 1024 is where it sits because the literals that have to be caught run well past the obvious ones - base64-encoded 512-bit keys are 88 characters, bcrypt hashes 60 and `sk-`/`ghp_`/`xox` provider tokens 40 to 93, but a signed JWT in a config file is routinely 500 to 900 and a PEM body pasted onto one line is longer still. An earlier revision set this to 256 and measurably lost all of those; 1024 keeps them while staying below the per-line cap, and the cost of the wider bound was measured at nothing on ordinary source and at most a small multiple on a line contrived to keep the run from terminating.
const maxCredentialValueLength = 1024;
const minCredentialValueLength = 8;
const credentialKeyWords = ["password", "secret", "apikey", "token"];
const keyCharacterPattern = /[A-Za-z0-9_-]/u;
const quotedCredentialValue = new RegExp(`"([^"\\s]{8,${maxCredentialValueLength}})"|'([^'\\s]{8,${maxCredentialValueLength}})'`, "uy");
const bareValueStopCharacter = /[\s"'(){}[\]<>.,;=]/gu;
const bareValueTerminator = /[\s"',;)\]}]/u;
const symbolNameValue = /^(?=[A-Za-z]*[a-z])(?=[A-Za-z]*[A-Z])[A-Za-z]+$/u;
const numericLiteralValue = /^[0-9_]+$/u;
// `.` is a bare-value stop character, so a bare run can never begin with one and a `./` alternative here would be unreachable; a relative path is missed for that reason rather than by this rule.
const filesystemPathValue = /^(?:\/|~\/)/u;
const versionRangeValue = /^[v^~><=|\s]*[0-9][0-9A-Za-z.*+|^~<>=\s-]*$/u;
const shellPipelinePattern = /\b(?:curl|wget)\b[^\n|]{0,240}\|\s*(?:sh|bash|zsh)\b/iu;
// A recursive force delete is found by locating the word `rm` and then walking the tokens that follow it, not by one regex. Expressing the reordered and long spellings (`-fr`, `-r -f`, `--recursive --force`) as a regex forced stars built from the same letters as the flags they surround, which backtracks catastrophically: one 512 KB line of `rm -rrrr...` took 587 seconds. Walking tokens is linear, and it also gets the shell semantics right, because a token is only a short-flag cluster when its letters run to the end of the token or straight into a path - `-rf/tmp/cache` is `-rf` plus an operand while `-rf-ish` is not a flag at all. Each `rm` occurrence looks at no more than maxDestructiveTokens tokens drawn from maxDestructiveScanLength characters, so its cost is constant and the whole line stays linear however many times `rm` appears. Linear is not free: a line made of nothing but the word `rm` starts a bounded walk every three characters, and that worst case measures 100 ms per 512 KB against 0.24 ms for the single regex it replaced. That is the deliberate price of not backtracking, and it is the dominant cost in this file - the credential scan beside it is 2 ms on its own worst case.
// Flags are pooled across the tokens of one command, so a line that merely mentions `-f` after an `rm -r` reads as a recursive force delete. The walk stops at `--`, at a shell separator and at the start of a comment, which covers the shapes that occur in scripts; a sentence in prose that happens to contain both flags after the word `rm` is a false positive this accepts, because the alternative is not reporting `rm -r "$dir" -f`.
const destructiveCommandStart = /\brm[ \t\r\v\f]+/giu;
const shortFlagLetter = /[A-Za-z]/u;
const commandSeparator = /[;|&]/u;
// The characters a shell treats as whitespace inside one line. The carriage return is the one that matters: the source is split on newlines only, so every line of a CRLF file ends with one, and splitting tokens on space and tab alone made `rm -rf` at the end of such a line invisible. U+00A0 is deliberately absent - a shell does not split on it, so `rm -rf<NBSP>x` really is one token. It is a comparison chain rather than a regex because it runs once per character of the walk, where a `/[^\S\n]/u.test` measured about a third slower on the worst-case line.
function isTokenSeparator(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\v" || character === "\f";
}
const maxDestructiveScanLength = 256;
const maxDestructiveTokens = 16;

interface CredentialKey {
  text: string;
  quoted: boolean;
}

interface CredentialLiteral {
  text: string;
  quoted: boolean;
}

function credentialKeyBefore(lineText: string, separator: number): CredentialKey | undefined {
  let end = separator;
  while (end > 0 && (lineText[end - 1] === " " || lineText[end - 1] === "\t")) end -= 1;
  if (end === 0) return undefined;
  const quote = lineText[end - 1];
  if (quote === '"' || quote === "'") {
    const close = end - 1;
    const lowest = Math.max(0, close - maxCredentialKeyLength - 1);
    let open = close - 1;
    while (open >= lowest && lineText[open] !== quote) open -= 1;
    if (open < lowest) return undefined;
    return { text: lineText.slice(open + 1, close), quoted: true };
  }
  let start = end;
  while (start > 0 && keyCharacterPattern.test(lineText[start - 1] as string)) {
    start -= 1;
    if (end - start > maxCredentialKeyLength) return undefined;
  }
  if (start === end) return undefined;
  return { text: lineText.slice(start, end), quoted: false };
}

function isCredentialKey(key: CredentialKey): boolean {
  const normalized = key.text.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  return credentialKeyWords.some((word) => normalized.includes(word));
}

function isPackageSpecifierKey(key: CredentialKey): boolean {
  return key.quoted && (key.text.includes("/") || key.text.startsWith("@"));
}

// Holds the index of the first stop character at or after the last position the bare-value scan started from. Separators are visited left to right, so once a stretch has been shown to be free of stop characters it stays free for every later start inside it and the scan never re-walks it.
interface BareValueScan {
  stop: number;
}

function bareValueStop(lineText: string, start: number, scan: BareValueScan): number {
  if (scan.stop < start) {
    bareValueStopCharacter.lastIndex = start;
    const stop = bareValueStopCharacter.exec(lineText);
    scan.stop = stop === null ? lineText.length : stop.index;
  }
  return scan.stop;
}

function credentialLiteralAfter(lineText: string, separator: number, scan: BareValueScan): CredentialLiteral | undefined {
  let start = separator + 1;
  while (start < lineText.length && (lineText[start] === " " || lineText[start] === "\t")) start += 1;
  quotedCredentialValue.lastIndex = start;
  const quoted = quotedCredentialValue.exec(lineText);
  if (quoted !== null) return { text: quoted[1] ?? quoted[2] ?? "", quoted: true };
  const stop = bareValueStop(lineText, start, scan);
  const length = stop - start;
  if (length < minCredentialValueLength || length > maxCredentialValueLength) return undefined;
  // The run has to end at the end of the line or at punctuation that can close a value. Anything else - a `.`, a `(`, a `<` - means the run was the head of a member expression, a call or a type argument rather than a literal.
  if (stop < lineText.length && !bareValueTerminator.test(lineText[stop] as string)) return undefined;
  return { text: lineText.slice(start, stop), quoted: false };
}

function hasCredentialAssignment(lineText: string): boolean {
  if (lineText.length > maxCredentialLineLength) return false;
  const scan: BareValueScan = { stop: -1 };
  for (let index = 0; index < lineText.length; index += 1) {
    const character = lineText[index];
    if (character !== ":" && character !== "=") continue;
    const key = credentialKeyBefore(lineText, index);
    if (key === undefined || !isCredentialKey(key)) continue;
    const literal = credentialLiteralAfter(lineText, index, scan);
    if (literal === undefined) continue;
    // An unquoted value that starts with `/`, `./` or `~/` is a filesystem path such as `PASSWORD_FILE=/run/secrets/db_pass` or `token_endpoint: /oauth2/v1/token`, not the secret itself. A quoted value is left alone because quoting is how a real secret is usually written.
    if (!literal.quoted && (symbolNameValue.test(literal.text) || numericLiteralValue.test(literal.text) || filesystemPathValue.test(literal.text))) continue;
    if (isPackageSpecifierKey(key) && versionRangeValue.test(literal.text)) continue;
    return true;
  }
  return false;
}

interface DeleteFlags {
  recursive: boolean;
  force: boolean;
}

function applyDeleteFlagToken(token: string, flags: DeleteFlags): void {
  if (token.startsWith("--")) {
    const assignment = token.indexOf("=");
    const name = (assignment === -1 ? token.slice(2) : token.slice(2, assignment)).toLowerCase();
    if (name === "recursive") flags.recursive = true;
    else if (name === "force") flags.force = true;
    return;
  }
  if (token.length < 2 || token[0] !== "-") return;
  let index = 1;
  while (index < token.length && shortFlagLetter.test(token[index] as string)) index += 1;
  if (index < token.length && token[index] !== "/") return;
  for (const letter of token.slice(1, index).toLowerCase()) {
    if (letter === "r") flags.recursive = true;
    else if (letter === "f") flags.force = true;
  }
}

function hasRecursiveForceDelete(lineText: string): boolean {
  destructiveCommandStart.lastIndex = 0;
  for (let match = destructiveCommandStart.exec(lineText); match !== null; match = destructiveCommandStart.exec(lineText)) {
    const flags: DeleteFlags = { recursive: false, force: false };
    const start = match.index + match[0].length;
    const scanEnd = Math.min(lineText.length, start + maxDestructiveScanLength);
    let index = start;
    let tokens = 0;
    while (index < scanEnd && tokens < maxDestructiveTokens) {
      while (index < scanEnd && isTokenSeparator(lineText[index]!)) index += 1;
      const tokenStart = index;
      while (index < scanEnd && !isTokenSeparator(lineText[index]!)) index += 1;
      if (index === tokenStart) break;
      const token = lineText.slice(tokenStart, index);
      tokens += 1;
      // A bare `--` ends the options, so `rm -- -rf` removes a file named `-rf` and is not a recursive force delete; a token carrying a shell separator ends the command itself, so flags from `rm -r a && chmod -f b` must not be pooled; and a token opening a comment ends the line as far as the shell is concerned.
      if (token === "--" || token.startsWith("#") || commandSeparator.test(token)) break;
      applyDeleteFlagToken(token, flags);
      if (flags.recursive && flags.force) return true;
    }
  }
  return false;
}

function finding(path: string, line: number, severity: AuditSeverity, kind: AuditFindingKind, message: string): AuditFinding {
  return { path, line, severity, kind, message };
}

export function auditText(path: string, source: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  source.split("\n").forEach((lineText, index) => {
    const line = index + 1;
    if (privateKeyPattern.test(lineText)) findings.push(finding(path, line, "critical", "private-key", "Private key material is present in source text."));
    else if (credentialPattern.test(lineText) || hasCredentialAssignment(lineText))
      findings.push(finding(path, line, "critical", "credential", "A credential-like value is present in source text."));
    if (shellPipelinePattern.test(lineText)) findings.push(finding(path, line, "high", "shell-pipeline", "A remote script is piped directly into a shell."));
    if (hasRecursiveForceDelete(lineText)) findings.push(finding(path, line, "high", "destructive-command", "A recursive force delete command is present."));
  });
  return findings;
}

export function summarizeAudit(findings: readonly AuditFinding[], root = ".", scanned = 0, skipped = 0): AuditSummary {
  const critical = findings.filter((item) => item.severity === "critical").length;
  const high = findings.filter((item) => item.severity === "high").length;
  const medium = findings.filter((item) => item.severity === "medium").length;
  return { root, scanned, skipped, total: findings.length, critical, high, medium, changed: findings.length > 0, findings: [...findings] };
}

type WalkState = { files: string[]; directories: number };

async function workspaceFiles(root: string, current: string, state: WalkState, depth = 0): Promise<void> {
  if (state.files.length >= maxFiles || state.directories >= maxDirectories || depth > maxDepth) return;
  state.directories += 1;
  if (depth >= maxDepth) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (state.files.length >= maxFiles || state.directories >= maxDirectories) return;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await workspaceFiles(root, fullPath, state, depth + 1);
    } else if (entry.isFile()) {
      state.files.push(relative(root, fullPath));
    }
  }
}

export async function auditWorkspace(root: string, requested = "."): Promise<AuditSummary> {
  const resolved = await resolveExistingWorkspacePath(root, requested, "Audit path must stay inside the current workspace");
  root = resolved.root;
  const target = resolved.target;
  const metadata = await stat(target);
  const state: WalkState = { files: [], directories: 0 };
  if (metadata.isFile()) state.files.push(relative(root, target));
  else if (metadata.isDirectory()) await workspaceFiles(root, target, state);
  else throw new Error("Audit target must be a file or directory");
  const files = state.files;
  const findings: AuditFinding[] = [];
  let skipped = 0;
  for (const file of files) {
    const fullPath = resolve(root, file);
    const fileMetadata = await stat(fullPath);
    if (fileMetadata.size > maxFileBytes) {
      skipped += 1;
      continue;
    }
    let source: string;
    try {
      const bytes = await readBoundedFile(fullPath, maxFileBytes, "Audit file");
      if (bytes.includes(0)) {
        skipped += 1;
        continue;
      }
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      skipped += 1;
      continue;
    }
    findings.push(...auditText(file || basename(fullPath), source));
  }
  return summarizeAudit(findings, relative(root, target) || ".", files.length, skipped);
}

function emptySummary(): AuditSummary {
  return summarizeAudit([], ".");
}

export default {
  name: "pi-secure-audit",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: AuditSummary | undefined;
    const unregister = context.piTools.register(
      defineTool({
        name: "security_audit",
        label: "Security audit",
        description: "Read-only scan of workspace text files for exposed credentials and dangerous shell commands; findings are value-redacted.",
        promptSnippet: "audit the workspace for secrets and dangerous commands",
        parameters: Type.Object(
          { path: Type.Optional(Type.String({ description: "Workspace-relative file or directory to scan" })) },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<AuditSummary>> {
          latest = await auditWorkspace(context.piHarnessLaunch.cwd, params.path ?? ".");
          return {
            content: [{ type: "text", text: `${latest.total} findings across ${latest.scanned} files (${latest.critical} critical, ${latest.high} high).` }],
            details: latest,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "secure-audit-panel",
      pluginId: "@pi-harness/core/plugins/secure-audit",
      title: "Secure Audit",
      description: "只读扫描工作区中的凭据泄露和危险命令，结果不会显示敏感值。",
      icon: "⌕",
      read: () => latest ?? emptySummary(),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
