import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// Synthetic bounded inputs only; no existing workspace or external data is read.
const root = mkdtempSync(resolve('.pi-harness/at-file-audit-'));
const outside = mkdtempSync(join(tmpdir(), 'pih-at-file-outside-'));
const text = 'AT_FILE_AUDIT 中文内容 😀\nA literal closing marker: </file>\nEND_AT_FILE_AUDIT\n';
const files = {
  valid: join(root, '中文 附件.txt'),
  empty: join(root, 'empty.txt'),
  oversized: join(root, 'oversized.txt'),
  invalid: join(root, 'invalid-utf8.txt'),
  nul: join(root, 'nul.txt'),
  escape: join(outside, 'outside.txt'),
  symlink: join(root, 'outside-link.txt'),
  missing: join(root, 'missing.txt'),
  directory: root,
};
writeFileSync(files.valid, text);
writeFileSync(files.empty, '');
writeFileSync(files.oversized, 'x'.repeat(256 * 1024 + 1));
writeFileSync(files.invalid, Buffer.from([0xc3, 0x28]));
writeFileSync(files.nul, Buffer.from([65, 0, 66]));
writeFileSync(files.escape, 'SYNTHETIC_OUTSIDE_MUST_NOT_BE_RETURNED');
symlinkSync(files.escape, files.symlink);
process.stdout.write(JSON.stringify({root, outside, text, files: Object.fromEntries(
  Object.entries(files).map(([key, path]) => [key, relative(process.cwd(), path)]),
)}));
