// Turns content/dist/library.json into out/seed.sql: the public chants, upserted by slug.
// Private rows have their own seed in cantor-content and are never written here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const library = JSON.parse(readFileSync(path.join(root, "content/dist/library.json"), "utf8"));
const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

const COLUMNS = ["slug", "title", "name", "mode", "kind", "book", "source", "url", "words", "gabc"];
const sql = library.map(
  (c) =>
    `INSERT INTO chants (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((k) => q(c[k])).join(", ")})\n` +
    `  ON CONFLICT(slug) DO UPDATE SET ${COLUMNS.slice(1).map((k) => `${k} = excluded.${k}`).join(", ")};`,
);
const out = path.join(root, "out/seed.sql");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, sql.join("\n") + "\n");
console.log(`${library.length} chants -> ${path.relative(process.cwd(), out)}`);
console.log(`apply with: npx wrangler d1 execute cantor --local --file ${path.relative(process.cwd(), out)}`);
