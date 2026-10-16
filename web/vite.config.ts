import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: { alias: { neuma: here("../vendor/neuma/neuma.mjs") } },
  build: {
    target: "es2022",
    rollupOptions: {
      // The worklet is its own entry, loaded with audioWorklet.addModule; it shares no module
      // with the page, so it bundles to one self-contained file at a fixed path.
      input: { main: here("index.html"), worklet: here("src/worklet/processor.ts") },
      output: {
        entryFileNames: (chunk) => (chunk.name === "worklet" ? "worklet.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  preview: { port: 4173, strictPort: true },
  test: { include: ["test/**/*.test.ts"] },
});
