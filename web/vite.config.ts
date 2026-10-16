import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The pages, by the clean paths the site links to; Cloudflare's assets serve /library from
// library.html, and this does the same in dev and preview.
const PAGES = ["library", "sing"];
const cleanUrls = (): Plugin => {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const [path, query] = (req.url ?? "").split(/(?=\?)/);
    const page = path?.replace(/^\/|\/$/g, "");
    if (page && PAGES.includes(page)) req.url = `/${page}.html${query ?? ""}`;
    next();
  };
  return {
    name: "clean-urls",
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
};

export default defineConfig({
  plugins: [cleanUrls()],
  resolve: { alias: { neuma: here("../vendor/neuma/neuma.mjs") } },
  build: {
    target: "es2022",
    rollupOptions: {
      // The worklet is its own entry, loaded with audioWorklet.addModule; it shares no module
      // with the page, so it bundles to one self-contained file at a fixed path.
      input: {
        main: here("index.html"),
        library: here("library.html"),
        sing: here("sing.html"),
        worklet: here("src/worklet/processor.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "worklet" ? "worklet.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  preview: { port: 4173, strictPort: true },
  test: { include: ["test/**/*.test.ts"] },
});
