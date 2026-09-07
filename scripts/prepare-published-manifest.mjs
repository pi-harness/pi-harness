import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import process from "node:process";

// Any npm command run inside the installed tree walks up to the root manifest, treats the installation as a workspace root - which it has to be, because that is how the shipped packages/* directories satisfy the launcher's own dependencies - and reifies every shipped workspace, dev dependencies included. That makes a shipped manifest's dependency lists part of what a user installs, so the ones that must not travel are removed here.
//
// apps/web ships for its bin entrypoint, its built assets and the profile it seeds the harness home from, but the packages it is built out of - @pi-harness/client-web and @pi-harness/web-app - are private and never published, so its lists reach users as names npm can never resolve and fail every install with E404.
//
// The API gateway's dev dependencies are the plugins its tests drive. They are published, so they resolve, which is worse than failing: a user who installs the launcher would silently download two dozen plugins nobody asked for.
const strippedManifests = [
  { path: "apps/web/package.json", fields: ["dependencies", "devDependencies"] },
  { path: "packages/api-gateway/package.json", fields: ["devDependencies"] },
];
// One file records every manifest the strip touched, so a restore needs no argument and an interrupted pack leaves behind exactly what the next strip needs to recover.
const backupPath = "published-manifest.backup.json";

/** @param {string} path */
const readJson = (path) => {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} does not contain an object`);
  return /** @type {Record<string, unknown>} */ (parsed);
};

const restore = () => {
  if (!existsSync(backupPath)) return false;
  for (const [path, source] of Object.entries(readJson(backupPath))) {
    if (typeof source === "string") writeFileSync(path, source);
  }
  rmSync(backupPath, { force: true });
  return true;
};

const strip = () => {
  // A pack that died between prepack and postpack left the working tree stripped; restoring first makes the backup describe the manifests as they are committed rather than as a previous run left them.
  restore();
  /** @type {Record<string, string>} */
  const backup = {};
  for (const { path, fields } of strippedManifests) {
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const manifest = readJson(path);
    if (!fields.some((field) => field in manifest)) continue;
    backup[path] = source;
    for (const field of fields) delete manifest[field];
    writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`);
  }
  if (Object.keys(backup).length > 0) writeFileSync(backupPath, `${JSON.stringify(backup, undefined, 2)}\n`);
};

const mode = process.argv[2];
if (mode === "--strip") strip();
else if (mode === "--restore") restore();
else throw new Error("Usage: node scripts/prepare-published-manifest.mjs --strip|--restore");
