import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Rust build output. Tauri writes generated .js codegen assets under src-tauri/target, and the type-aware
    // rules try to parse them against a tsconfig that does not include them, so a desktop build breaks lint:check.
    ignores: ["**/dist/**", "**/server-dist/**", "**/target/**", "**/node_modules/**", "packages/api-gateway/scripts/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "scripts/*.mjs", "packages/plugins/*/test/fixtures/*.mjs", "examples/api-client/*.mjs"],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 12,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
