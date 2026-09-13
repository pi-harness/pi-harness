import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import packageMetadata from "./package.json" with { type: "json" };

export default defineConfig({
  define: { __PI_HARNESS_VERSION__: JSON.stringify(packageMetadata.version) },
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react-vendor", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/u },
            { name: "markdown-vendor", test: /node_modules[\\/](?:marked|dompurify)[\\/]/u },
          ],
        },
      },
    },
  },
  plugins: [tailwindcss()],
});
