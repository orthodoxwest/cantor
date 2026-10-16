import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The pages, by the clean paths the site links to; Cloudflare's assets serve /library from
// library.html, and this does the same in dev and preview.
const PAGES = ["library", "sing", "diagnostics"];
// Without the Worker, dev and preview answer the library's two routes from the public chants
// content/build.mjs writes; private rows only ever come from the Worker.
const LIBRARY = here("../content/dist/library.json");
type Row = Record<string, unknown> & { slug: string; gabc: string };
let cached: { mtime: number; rows: Row[] } | null = null;
const rows = (): Row[] => {
  const mtime = statSync(LIBRARY).mtimeMs;
  if (cached?.mtime !== mtime) cached = { mtime, rows: JSON.parse(readFileSync(LIBRARY, "utf8")) };
  return cached.rows;
};
const chantsApi: Connect.NextHandleFunction = (req, res, next) => {
  const m = /^\/api\/chants(?:\/([^/?]+))?(?:\?|$)/.exec(req.url ?? "");
  if (!m) return next();
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  let all: Row[];
  try {
    all = rows();
  } catch {
    return send(503, { error: "run node content/build.mjs first" });
  }
  if (m[1] === undefined) return send(200, all.map(({ gabc: _, ...row }) => row));
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return send(404, { error: "not found" });
  }
  const row = all.find((r) => r.slug === slug);
  return row ? send(200, row) : send(404, { error: "not found" });
};

const cleanUrls = (): Plugin => {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const [path, query] = (req.url ?? "").split(/(?=\?)/);
    const page = path?.replace(/^\/|\/$/g, "");
    if (page && PAGES.includes(page)) req.url = `/${page}.html${query ?? ""}`;
    // A take's page, as the Worker serves /take/ID.
    else if (page && /^take\/[^/]+$/.test(page)) req.url = `/take.html${query ?? ""}`;
    next();
  };
  return {
    name: "clean-urls",
    configureServer: (server) => void server.middlewares.use(rewrite).use(chantsApi),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite).use(chantsApi),
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
        take: here("take.html"),
        diagnostics: here("diagnostics.html"),
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
