import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["**/dist/**", "**/server-dist/**", "**/node_modules/**"],
    printWidth: 160,
    semi: true,
    singleQuote: false,
  },
});
