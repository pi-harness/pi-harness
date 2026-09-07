import { fileURLToPath } from "node:url";

export const BUILTIN_PROFILES = ["default", "development"] as const;

// The launcher ships the curated plugin set, so the profile directory sits next to its build output rather than inside the runtime package.
export const BUILTIN_PROFILES_DIR = fileURLToPath(new URL("../profiles", import.meta.url));
