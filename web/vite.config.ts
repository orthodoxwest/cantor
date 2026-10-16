import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: { alias: { neuma: here("../vendor/neuma/neuma.mjs") } },
  build: {
    target: "es2022",
  },
  preview: { port: 4173, strictPort: true },
  test: { include: ["test/**/*.test.ts"] },
});
