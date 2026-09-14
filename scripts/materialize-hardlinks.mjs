import { chmod, copyFile, lstat, opendir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
if (args.length !== 1) throw new Error("Usage: node scripts/materialize-hardlinks.mjs <directory>");

const root = resolve(args[0]);
const rootStats = await lstat(root);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error(`Hard-link materialization root must be a directory: ${root}`);

let materialized = 0;
let temporarySequence = 0;

/** @param {string} directory */
const materializeDirectory = async (directory) => {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await materializeDirectory(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = await lstat(path);
    if (!stats.isFile() || stats.nlink < 2) continue;

    temporarySequence += 1;
    const temporary = join(dirname(path), `.${basename(path)}.materialize-${process.pid}-${temporarySequence}`);
    try {
      await copyFile(path, temporary);
      await chmod(temporary, stats.mode);
      await rename(temporary, path);
      materialized += 1;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
};

await materializeDirectory(root);
process.stdout.write(`materialized ${materialized} hard-linked file${materialized === 1 ? "" : "s"}\n`);
