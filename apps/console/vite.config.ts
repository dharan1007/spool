import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, "renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(here, "dist/renderer"),
    emptyOutDir: true
  }
});
