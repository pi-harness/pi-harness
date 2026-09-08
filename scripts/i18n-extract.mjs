// Extracts the console's Chinese source strings and, with --write, rewrites the display sites to call t().
// The Chinese text is the message key, so this script is also what keeps the catalogs in step with the source: run it after adding UI copy.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages/client-web/src");
const LOCALES = join(SRC, "locales");
const WRITE = process.argv.includes("--write");
const CJK = /[一-鿿]/u;

// Attributes whose value a person reads. Every other attribute holding Chinese would be a React key or a selector, and translating those changes behaviour rather than wording.
const VISIBLE_ATTRIBUTES = new Set(["title", "placeholder", "alt", "aria-label", "aria-description", "aria-placeholder", "aria-valuetext"]);

// i18n.ts is the runtime itself, design-contract.ts is a test fixture nobody renders, and annotation-ui.ts builds the prompt text sent to the model and parses it back out of saved sessions, where a translated marker would stop matching.
const EXCLUDED = new Set(["i18n.ts", "design-contract.ts", "annotation-ui.ts"]);

function sourceFiles() {
  return readdirSync(SRC)
    .filter((name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !EXCLUDED.has(name))
    .map((name) => join(SRC, name));
}

/** @param {ts.Node} node */
function isInsideTranslateCall(node) {
  const parent = node.parent;
  return (
    parent !== undefined && ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "t" && parent.arguments[0] === node
  );
}

/**
 * A string literal that drives control flow rather than display: a comparison operand, a case label, an object key, a lookup subscript, a type, or an import path.
 * @param {ts.Node} node
 */
function isLogicPosition(node) {
  const parent = node.parent;
  if (parent === undefined) return true;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isImportTypeNode(parent) || ts.isModuleDeclaration(parent)) return true;
  if (ts.isLiteralTypeNode(parent)) return true;
  if (ts.isCaseClause(parent)) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isComputedPropertyName(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      kind === ts.SyntaxKind.EqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsToken
    )
      return true;
  }
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText();
    return !VISIBLE_ATTRIBUTES.has(name);
  }
  return false;
}

/**
 * Puts `t` in scope in a file the rewrite just touched, after the last existing import so the import block stays one block.
 * @param {string} text
 * @param {ts.SourceFile} source
 */
function withTranslateImport(text, source) {
  const imports = source.statements.filter((statement) => ts.isImportDeclaration(statement));
  if (imports.some((statement) => statement.moduleSpecifier.getText().includes("./i18n.js"))) return text;
  const statement = 'import { t } from "./i18n.js";';
  const last = imports.at(-1);
  if (last === undefined) return `${statement}\n\n${text}`;
  const end = last.getEnd();
  return `${text.slice(0, end)}\n${statement}${text.slice(end)}`;
}

/**
 * A module-scope literal is evaluated once at import, before any catalog is loaded, so translating it there would freeze the console in whatever language happened to be active first.
 * @param {ts.Node} node
 */
function isModuleScope(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    )
      return false;
  }
  return true;
}

/** @param {string} file */
function collect(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  /** @type {{ start: number; end: number; replacement: string }[]} */
  const edits = [];
  /** @type {Set<string>} */
  const strings = new Set();
  /** @type {{ text: string; why: string; line: number }[]} */
  const skipped = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isStringLiteral(node) && CJK.test(node.text)) {
      if (isInsideTranslateCall(node)) {
        strings.add(node.text);
      } else if (isLogicPosition(node)) {
        skipped.push({
          text: node.text,
          why: node.parent ? ts.SyntaxKind[node.parent.kind] : "?",
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      } else if (isModuleScope(node)) {
        // A module-scope table still needs its text in the catalogs; only the t() call has to move to wherever the table is read.
        strings.add(node.text);
        skipped.push({ text: node.text, why: "ModuleScope", line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      } else {
        const inAttribute = node.parent !== undefined && ts.isJsxAttribute(node.parent);
        const call = `t(${JSON.stringify(node.text)})`;
        edits.push({ start: node.getStart(), end: node.getEnd(), replacement: inAttribute ? `{${call}}` : call });
        strings.add(node.text);
      }
    } else if (ts.isJsxText(node) && CJK.test(node.text)) {
      const trimmed = node.text.trim();
      if (trimmed !== "") {
        // JsxText counts its leading whitespace as part of the token, so the offset is measured from the full start rather than from getStart(), which has already skipped it.
        const offset = node.text.indexOf(trimmed);
        const start = node.getFullStart() + offset;
        edits.push({ start, end: start + trimmed.length, replacement: `{t(${JSON.stringify(trimmed)})}` });
        strings.add(trimmed);
      }
    } else if (ts.isNoSubstitutionTemplateLiteral(node) && CJK.test(node.text)) {
      skipped.push({ text: node.text, why: "NoSubstitutionTemplate", line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    } else if (ts.isTemplateExpression(node) && CJK.test(node.getText())) {
      skipped.push({ text: node.getText().slice(0, 90), why: "TemplateExpression", line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { text, edits, strings, skipped, source };
}

/** @type {Set<string>} */
const allStrings = new Set();
/** @type {{ file: string; text: string; why: string; line: number }[]} */
const allSkipped = [];
let changedFiles = 0;
for (const file of sourceFiles()) {
  const { text, edits, strings, skipped, source } = collect(file);
  strings.forEach((value) => allStrings.add(value));
  skipped.forEach((entry) => allSkipped.push({ file: relative(ROOT, file), ...entry }));
  if (!WRITE || edits.length === 0) continue;
  let next = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
  writeFileSync(file, withTranslateImport(next, source));
  changedFiles += 1;
  process.stdout.write(`${relative(ROOT, file)}: ${edits.length} 处\n`);
}

const keys = [...allStrings].sort();
if (WRITE) {
  for (const name of readdirSync(LOCALES).filter((entry) => entry.endsWith(".json"))) {
    const path = join(LOCALES, name);
    /** @type {unknown} */
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} does not contain an object`);
    const existing = /** @type {Record<string, string>} */ (parsed);
    /** @type {Record<string, string>} */
    const merged = {};
    for (const key of keys) merged[key] = existing[key] ?? "";
    writeFileSync(path, `${JSON.stringify(merged, undefined, 2)}\n`);
  }
}
process.stdout.write(`\n可翻译字符串 ${keys.length} 条，改写文件 ${changedFiles} 个，跳过 ${allSkipped.length} 处\n`);
if (process.argv.includes("--skipped"))
  for (const entry of allSkipped) process.stdout.write(`  ${entry.file}:${entry.line} [${entry.why}] ${entry.text.replace(/\n/g, " ").slice(0, 80)}\n`);
