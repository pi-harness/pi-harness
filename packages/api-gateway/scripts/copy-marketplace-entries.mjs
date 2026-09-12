import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageDirectory, "src/marketplace-entries");
const destination = resolve(packageDirectory, "dist/marketplace-entries");
const localeSource = resolve(packageDirectory, "src/marketplace-locales");
const localeDestination = resolve(packageDirectory, "dist/marketplace-locales");
const legacyRegistry = resolve(packageDirectory, "dist/marketplace-registry.json");

await rm(destination, { recursive: true, force: true });
await rm(localeDestination, { recursive: true, force: true });
await rm(legacyRegistry, { force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await mkdir(localeDestination, { recursive: true });
await cp(localeSource, localeDestination, { recursive: true });
