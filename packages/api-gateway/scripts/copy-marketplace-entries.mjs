import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageDirectory, "src/marketplace-entries");
const destination = resolve(packageDirectory, "dist/marketplace-entries");
const legacyRegistry = resolve(packageDirectory, "dist/marketplace-registry.json");

await rm(destination, { recursive: true, force: true });
await rm(legacyRegistry, { force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
