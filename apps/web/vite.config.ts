import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
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
